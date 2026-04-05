const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { resolve } = require('../lib/identity-resolver');
const { lookupCustomer } = require('../lib/customer-lookup');
const { getCompany } = require('../lib/hubspot');
const { generateRapportIntel, clearCache } = require('../lib/claude');
const { buildVernacular } = require('../lib/company-vernacular');
const { normalizePhone } = require('../lib/phone');
const { TEST_COCKPIT_DATA } = require('../lib/test-cockpit-data');
const SIM_MIKE_GARZA = require('../config/sim-contacts/mike-garza.json');
const SIM_MIKE_GARZA_BY_DIFFICULTY = {
  easy:   require('../config/sim-contacts/mike-garza-easy.json'),
  medium: require('../config/sim-contacts/mike-garza-medium.json'),
  hard:   require('../config/sim-contacts/mike-garza-hard.json'),
};

const router = Router();

// GET /api/cockpit/:identifier — full pre-call briefing
router.get('/:identifier', apiKeyAuth, async (req, res) => {
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

    const queries = [
      // 0: Cross-channel interaction history
      lookupCustomer({ phone, email, contactId }).catch(() => null),

      // 1: Prior nucleus-phone calls
      phone
        ? pool.query(
            `SELECT id, created_at, caller_identity, disposition, qualification,
                    notes, duration_seconds, products_discussed
             FROM nucleus_phone_calls
             WHERE lead_phone LIKE $1 AND status = 'completed'
             ORDER BY created_at DESC LIMIT 20`,
            [`%${phone.slice(-7)}`]
          ).then(r => r.rows).catch(() => [])
        : Promise.resolve([]),

      // 2: Discovery pipeline data (case-insensitive exact match)
      identity.company
        ? pool.query(
            `SELECT domain, company_name, segment, status, discovery_source,
                    created_at, enriched_at
             FROM v35_discovery_queue
             WHERE LOWER(company_name) = LOWER($1)
             ORDER BY created_at DESC LIMIT 5`,
            [identity.company]
          ).then(r => r.rows).catch(() => [])
        : Promise.resolve([]),

      // 3: ICP score + signal metadata (single query via LEFT JOIN, avoids duplicate reservoir lookup)
      identity.company
        ? pool.query(
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
             WHERE LOWER(lr.company_name) = LOWER($1)
             LIMIT 1`,
            [identity.company]
          ).then(r => r.rows[0] || null).catch(() => null)
        : Promise.resolve(null),

      // 4: QA results
      email
        ? pool.query(
            `SELECT fields_available, validation_status, validated_at
             FROM qa_results
             WHERE email = $1
             ORDER BY validated_at DESC LIMIT 1`,
            [email]
          ).then(r => r.rows[0] || null).catch(() => null)
        : Promise.resolve(null),

      // 5: Email engagement from webhook events
      email
        ? pool.query(
            `SELECT event_type, created_at, payload_json->>'campaign_name' AS campaign_name
             FROM v35_webhook_events
             WHERE lead_email = $1
             ORDER BY created_at DESC LIMIT 10`,
            [email]
          ).then(r => r.rows).catch(() => [])
        : Promise.resolve([]),

      // 6: Company data from HubSpot
      identity.hubspotCompanyId
        ? getCompany(identity.hubspotCompanyId).catch(() => null)
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

    // Step 5: Return full cockpit payload
    res.json({
      identity,
      rapport,
      interactionHistory,
      priorCalls,
      pipelineData,
      icpScore,
      qaIntel,
      emailEngagement,
      companyData: companyData?.properties || null,
      signalMetadata,
      companyVernacular,
    });
  } catch (err) {
    console.error('Cockpit assembly failed:', err.message);
    res.status(500).json({ error: 'Failed to assemble cockpit data' });
  }
});

module.exports = router;
