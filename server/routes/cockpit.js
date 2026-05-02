const { Router } = require('express');
const { bearerOrApiKeyOrSession, isInteractiveCaller } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { pool } = require('../db');
const { resolve } = require('../lib/identity-resolver');
const { lookupCustomer } = require('../lib/customer-lookup');
const { getCompany } = require('../lib/hubspot');
const { generateRapportIntel, clearCache } = require('../lib/claude');
const { buildVernacular } = require('../lib/company-vernacular');
const { normalizePhone } = require('../lib/phone');
const { normalizeCompanyName } = require('../lib/company-normalizer');
const { TEST_COCKPIT_DATA } = require('../lib/test-cockpit-data');
const SIM_MIKE_GARZA = require('../config/sim-contacts/mike-garza.json');
const SIM_MIKE_GARZA_BY_DIFFICULTY = {
  easy:   require('../config/sim-contacts/mike-garza-easy.json'),
  medium: require('../config/sim-contacts/mike-garza-medium.json'),
  hard:   require('../config/sim-contacts/mike-garza-hard.json'),
};

const router = Router();

// GET /api/cockpit/next-uncalled — find next signal-scored contact without a
// completed call. Returns { next: { phone, full_name, company_name, signal_tier,
// signal_score } } or { next: null } when the queue is empty.
// Must be defined BEFORE /:identifier to avoid route shadowing.
router.get('/next-uncalled', bearerOrApiKeyOrSession, rbac('external_caller'), async (req, res) => {
  const { exclude } = req.query; // phone number of the current contact to skip past

  try {
    const params = [];
    let excludeClause = '';
    if (exclude) {
      // Strip to last 7 digits for format-agnostic comparison
      const digits = exclude.replace(/\D/g, '').slice(-7);
      if (digits.length === 7) {
        params.push(digits);
        excludeClause = `AND pb.phone_suffix7 != $${params.length}`;
      }
    }

    const { rows } = await pool.query(
      `SELECT pb.phone, pb.full_name, lr.company_name,
              sm.signal_tier, sm.signal_score
       FROM v35_pb_contacts pb
       JOIN v35_signal_metadata sm ON sm.domain = pb.domain
       JOIN v35_lead_reservoir lr ON lr.domain = pb.domain
       WHERE pb.phone_suffix7 IS NOT NULL
         AND pb.phone_type IN ('mobile', 'direct')
         AND pb.domain IS NOT NULL
         ${excludeClause}
         AND NOT EXISTS (
           SELECT 1 FROM nucleus_phone_calls npc
           WHERE npc.status = 'completed'
             AND npc.phone_suffix7 = pb.phone_suffix7
         )
       ORDER BY sm.signal_score DESC NULLS LAST
       LIMIT 1`,
      params,
    );

    res.json({ next: rows[0] || null });
  } catch (err) {
    console.error('Next-uncalled lookup failed:', err.message);
    res.status(500).json({ error: 'Failed to find next contact' });
  }
});

// GET /api/cockpit/:identifier — full pre-call briefing. Open to any logged-in
// caller (including external_caller) — cockpit data is lead-scoped, not
// rep-scoped, and external reps need the briefing to make the call.
router.get('/:identifier', bearerOrApiKeyOrSession, rbac('external_caller'), async (req, res) => {
  const { identifier } = req.params;
  const refresh = req.query.refresh === 'true';

  try {
    // Simulation contact — static data, no API calls
    if (identifier === 'sim-mike-garza') {
      const difficulty = req.query.difficulty;
      const simData = SIM_MIKE_GARZA_BY_DIFFICULTY[difficulty] || SIM_MIKE_GARZA;
      return res.json(simData);
    }

    // Test caller — return rich mock data, no API calls
    if (identifier === 'test-call') {
      return res.json(TEST_COCKPIT_DATA);
    }
    // Step 1: Identity resolution
    const identity = await resolve(identifier);

    // Bust cache on refresh
    if (refresh) {
      clearCache(identity.hubspotContactId || normalizePhone(identifier));
    }

    // Step 2: Parallel data assembly
    const phone = identity.phone || normalizePhone(identifier);
    const email = identity.email;
    const contactId = identity.hubspotContactId;

    const warnings = [];
    function softQuery(source, promise, fallback) {
      return promise.catch(err => {
        console.warn(`cockpit: ${source} failed:`, err.stack || err.message);
        warnings.push({ source, message: err.message });
        return fallback;
      });
    }

    const queries = [
      // 0: Cross-channel interaction history
      softQuery('interactionHistory', lookupCustomer({ phone, email, contactId }), null),

      // 1: Prior nucleus-phone calls (match by phone_suffix7 OR email)
      (() => {
        const clauses = [];
        const params = [];
        if (phone) {
          const suffix = phone.replace(/\D/g, '').slice(-7);
          if (suffix.length === 7) {
            params.push(suffix);
            clauses.push(`phone_suffix7 = $${params.length}`);
          }
        }
        if (email) {
          params.push(email);
          clauses.push(`LOWER(lead_email) = LOWER($${params.length})`);
        }
        if (!clauses.length) return Promise.resolve([]);
        return softQuery('priorCalls', pool.query(
          `SELECT id, created_at, caller_identity, disposition, qualification,
                  notes, duration_seconds, products_discussed,
                  ai_summary, ai_action_items
           FROM nucleus_phone_calls
           WHERE (${clauses.join(' OR ')}) AND status = 'completed'
           ORDER BY created_at DESC LIMIT 20`,
          params
        ).then(r => r.rows), []);
      })(),

      // 2: Discovery pipeline data (case-insensitive exact match)
      identity.company
        ? softQuery('pipelineData', pool.query(
            `SELECT domain, company_name, segment, status, discovery_source,
                    created_at, enriched_at
             FROM v35_discovery_queue
             WHERE LOWER(company_name) = LOWER($1)
             ORDER BY created_at DESC LIMIT 5`,
            [identity.company]
          ).then(r => r.rows), [])
        : Promise.resolve([]),

      // 3: ICP score + signal metadata (single query via LEFT JOIN)
      // Normalize both sides (strip LLC, Inc, Corp, etc.) for exact match.
      // Prefix LIKE was too greedy — "Shaw" matched "Shawnee State University".
      identity.company
        ? softQuery('icpAndSignal', pool.query(
            `SELECT lr.domain,
                    lr.icp_score, lr.prequalify_class, lr.prequalify_reasoning,
                    lr.industry_naics, lr.industry_description,
                    lr.employee_range, lr.revenue_range,
                    lr.geo_city, lr.geo_state, lr.geo_country,
                    lr.harvest_source, lr.contact_count, lr.signal_context,
                    sm.signal_tier, sm.signal_score, sm.source_count,
                    sm.cert_expiry_date, sm.cert_standard, sm.cert_body,
                    sm.contract_total, sm.dod_flag, sm.signal_sources
             FROM v35_lead_reservoir lr
             LEFT JOIN v35_signal_metadata sm ON sm.domain = lr.domain
             WHERE LOWER(REGEXP_REPLACE(
               lr.company_name,
               ',?\\s*(Inc\\.?|LLC|Corp\\.?|Ltd\\.?|Co\\.?|LP|L\\.P\\.?|Corporation|Limited|Company|Holdings|Group)\\s*$',
               '', 'i'
             )) = $1
             LIMIT 1`,
            [normalizeCompanyName(identity.company)]
          ).then(r => r.rows[0] || null), null)
        : Promise.resolve(null),

      // 4: QA results
      email
        ? softQuery('qaIntel', pool.query(
            `SELECT fields_available, validation_status, validated_at
             FROM qa_results
             WHERE email = $1
             ORDER BY validated_at DESC LIMIT 1`,
            [email]
          ).then(r => r.rows[0] || null), null)
        : Promise.resolve(null),

      // 5: Email engagement from webhook events
      email
        ? softQuery('emailEngagement', pool.query(
            `SELECT event_type, created_at, payload_json->>'campaign_name' AS campaign_name
             FROM v35_webhook_events
             WHERE lead_email = $1
             ORDER BY created_at DESC LIMIT 10`,
            [email]
          ).then(r => r.rows), [])
        : Promise.resolve([]),

      // 6: Company data from HubSpot
      identity.hubspotCompanyId
        ? softQuery('companyData', getCompany(identity.hubspotCompanyId), null)
        : Promise.resolve(null),

    ];

    const [
      interactionHistory,
      priorCalls,
      pipelineData,
      icpAndSignal,
      qaIntel,
      emailEngagement,
      companyData,
    ] = await Promise.all(queries);

    // Step 2b: Fetch enriched contacts using domain from ICP query
    const companyDomain = icpAndSignal?.domain || null;
    const enrichedContacts = companyDomain
      ? await softQuery('enrichedContacts', pool.query(
          `SELECT full_name, title, email, phone, linkedin_profile_url
           FROM v35_pb_contacts
           WHERE domain = $1
           ORDER BY phone IS NOT NULL DESC, email IS NOT NULL DESC
           LIMIT 10`,
          [companyDomain]
        ).then(r => r.rows), [])
      : [];

    // Split combined query #3 into ICP score (with company enrichment) and signal metadata
    const icpScore = icpAndSignal
      ? { domain: icpAndSignal.domain,
          icp_score: icpAndSignal.icp_score,
          prequalify_class: icpAndSignal.prequalify_class,
          prequalify_reasoning: icpAndSignal.prequalify_reasoning,
          industry_naics: icpAndSignal.industry_naics,
          industry_description: icpAndSignal.industry_description,
          employee_range: icpAndSignal.employee_range,
          revenue_range: icpAndSignal.revenue_range,
          geo_city: icpAndSignal.geo_city,
          geo_state: icpAndSignal.geo_state,
          geo_country: icpAndSignal.geo_country,
          harvest_source: icpAndSignal.harvest_source,
          contact_count: icpAndSignal.contact_count,
          signal_context: icpAndSignal.signal_context }
      : null;
    const signalMetadata = icpAndSignal?.signal_tier
      ? { signal_tier: icpAndSignal.signal_tier, signal_score: icpAndSignal.signal_score,
          source_count: icpAndSignal.source_count, cert_expiry_date: icpAndSignal.cert_expiry_date,
          cert_standard: icpAndSignal.cert_standard, cert_body: icpAndSignal.cert_body,
          contract_total: icpAndSignal.contract_total, dod_flag: icpAndSignal.dod_flag,
          signal_sources: icpAndSignal.signal_sources }
      : null;

    // Step 3: Company vernacular aggregation
    const companyVernacular = buildVernacular({
      icpAndSignal,
      interactionHistory,
      priorCalls,
      companyData,
    });

    // Step 4: Claude rapport intelligence
    const assembled = {
      ...identity,
      interactionHistory,
      priorCalls,
      pipelineData,
      icpScore,
      qaIntel,
      emailEngagement,
      companyData: companyData?.properties || null,
      signalMetadata,
      companyVernacular,
    };

    const rapport = await generateRapportIntel(assembled);

    // Ensure watch_outs is never empty — reps need objection prep
    if (!rapport.watch_outs?.length) {
      const watchOuts = [];
      if (signalMetadata?.dod_flag)
        watchOuts.push('DoD contractor — avoid discussing specific contract details, let them bring it up');
      if (companyVernacular?.competitorsMentioned?.length)
        watchOuts.push(`They know ${companyVernacular.competitorsMentioned[0]} — be ready with differentiators`);
      if (identity.title?.toLowerCase().includes('purchas') || identity.title?.toLowerCase().includes('procurement'))
        watchOuts.push('Purchasing role — expect price objections, lead with total cost of ownership');
      if (!watchOuts.length)
        watchOuts.push('First contact — listen before pitching, ask about their current setup');
      rapport.watch_outs = watchOuts;
    }

    // Strip AI fields from priorCalls for API-key callers. See CLAUDE.md:70.
    // Interactive callers (session + bearer) get the full thing; API-key
    // automation is the only caller withheld from ai_summary.
    const responsePriorCalls = isInteractiveCaller(req)
      ? priorCalls
      : priorCalls.map(({ ai_summary, ai_action_items, ...rest }) => rest);

    res.json({
      identity,
      rapport,
      interactionHistory,
      priorCalls: responsePriorCalls,
      pipelineData,
      icpScore,
      qaIntel,
      emailEngagement,
      companyData: companyData?.properties || null,
      signalMetadata,
      companyVernacular,
      enrichedContacts: enrichedContacts || [],
      ...(warnings.length ? { _warnings: warnings } : {}),
    });
  } catch (err) {
    console.error('Cockpit assembly failed:', err.message);
    res.status(500).json({ error: 'Failed to assemble cockpit data' });
  }
});

module.exports = router;
