const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { resolve } = require('../lib/identity-resolver');
const { lookupCustomer } = require('../lib/customer-lookup');
const { getCompany } = require('../lib/hubspot');
const { generateRapportIntel, clearCache } = require('../lib/claude');
const { normalizePhone } = require('../lib/phone');

const router = Router();

// GET /api/cockpit/:identifier — full pre-call briefing
router.get('/:identifier', apiKeyAuth, async (req, res) => {
  const { identifier } = req.params;
  const refresh = req.query.refresh === 'true';

  try {
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

      // 3: ICP score from lead reservoir (case-insensitive exact match)
      identity.company
        ? pool.query(
            `SELECT domain, fit_score, fit_reason, persona, segment
             FROM v35_lead_reservoir
             WHERE LOWER(company_name) = LOWER($1)
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
            `SELECT event_type, created_at, campaign_name
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
      icpScore,
      qaIntel,
      emailEngagement,
      companyData,
    ] = await Promise.all(queries);

    // Step 3: Claude rapport intelligence
    const assembled = {
      ...identity,
      interactionHistory,
      priorCalls,
      pipelineData,
      icpScore,
      qaIntel,
      emailEngagement,
      companyData: companyData?.properties || null,
    };

    const rapport = await generateRapportIntel(assembled);

    // Step 4: Return full cockpit payload
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
    });
  } catch (err) {
    console.error('Cockpit assembly failed:', err.message);
    res.status(500).json({ error: 'Failed to assemble cockpit data' });
  }
});

module.exports = router;
