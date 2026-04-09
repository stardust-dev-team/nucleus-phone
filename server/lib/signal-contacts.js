/**
 * lib/signal-contacts.js — Bridge between signal-scored companies and callable contacts.
 *
 * Signal scoring operates at the company level (domains in v35_signal_metadata).
 * Phone calls happen at the person level. This module bridges the gap by finding
 * contacts at signal-scored companies via v35_pb_contacts (joined through
 * v35_lead_reservoir for company_name → company_name_norm mapping).
 *
 * Note: phone and source columns on v35_pb_contacts are added by Phase 4 schema
 * migration. Until then, all contacts will have phone=null and source='phantombuster'.
 */

const { pool } = require('../db');
const { normalizeCompanyName } = require('./company-normalizer');

/**
 * Build the shared WHERE clause for signal company queries.
 * Used by both getSignalContacts and the pipeline route.
 * Safe: conditions are built from hardcoded column names only.
 */
function buildSignalWhere({ signal_tier, geo_state }) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (signal_tier) {
    conditions.push(`sm.signal_tier = $${idx++}`);
    values.push(signal_tier);
  }
  if (geo_state) {
    conditions.push(`lr.geo_state = $${idx++}`);
    values.push(geo_state);
  }

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values, idx };
}

/**
 * Get signal-scored companies with their known contacts, ordered by signal_score DESC.
 *
 * @param {Object} opts
 * @param {string} [opts.signal_tier] - Filter: 'spear' | 'targeted' | 'awareness'
 * @param {string} [opts.geo_state] - Filter: two-letter state code
 * @param {boolean} [opts.has_phone] - Only return companies with ≥1 phone contact (default true)
 * @param {number} [opts.limit] - Max companies (default 50, max 200)
 * @param {number} [opts.offset] - Pagination offset (default 0)
 * @returns {Promise<{ companies: Object[], total: number }>}
 */
async function getSignalContacts({
  signal_tier, geo_state, has_phone = true, limit = 50, offset = 0,
} = {}) {
  const { where, values, idx } = buildSignalWhere({ signal_tier, geo_state });
  const lim = Math.max(1, Math.min(limit, 200));
  const off = Math.max(0, offset);

  // Run companies query and count query in parallel
  const [companiesResult, countResult] = await Promise.all([
    pool.query(
      `SELECT lr.domain, lr.company_name, lr.geo_state,
              lr.enrichment_status,
              sm.signal_tier, sm.signal_score, sm.source_count,
              sm.cert_expiry_date, sm.cert_standard, sm.contract_total, sm.dod_flag,
              EXISTS (
                SELECT 1 FROM v35_pb_contacts pb
                WHERE pb.company_name_norm = LOWER(REGEXP_REPLACE(
                  lr.company_name, ',?\\s*(Inc\\.?|LLC|Corp\\.?|Ltd\\.?|Co\\.?|LP|L\\.P\\.?)\\s*$', '', 'i'
                ))
              ) AS has_contacts
       FROM v35_signal_metadata sm
       JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
       ${where}
       ORDER BY has_contacts DESC, sm.signal_score DESC NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, lim, off],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM v35_signal_metadata sm
       JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
       ${where}`,
      values,
    ),
  ]);

  const companies = companiesResult.rows;
  const total = countResult.rows[0]?.total || 0;
  if (companies.length === 0) return { companies: [], total };

  // Build normalized name → domain map (cache the norm for reuse in assembly)
  const companyNorms = new Map(); // domain → normalized name
  const normSet = [];
  for (const c of companies) {
    const norm = normalizeCompanyName(c.company_name);
    if (norm) {
      companyNorms.set(c.domain, norm);
      normSet.push(norm);
    }
  }

  // Fetch contacts at these companies
  const uniqueNorms = [...new Set(normSet)];
  const contactsResult = uniqueNorms.length > 0
    ? await pool.query(
        `SELECT full_name, first_name, last_name, title, company_name,
                company_name_norm, linkedin_profile_url, location, industry,
                CASE WHEN phone_type IN ('mobile', 'direct') THEN phone ELSE NULL END AS phone,
                email, source
         FROM v35_pb_contacts
         WHERE company_name_norm = ANY($1)`,
        [uniqueNorms],
      )
    : { rows: [] };

  const contacts = contactsResult.rows;

  // Fetch call history for found contacts, scoped by company to avoid cross-company name collisions
  const contactKeys = contacts
    .filter(c => c.full_name)
    .map(c => ({ name: c.full_name, company: c.company_name }));
  const contactNames = [...new Set(contactKeys.map(k => k.name))];
  const contactCompanies = [...new Set(contactKeys.map(k => k.company).filter(Boolean))];
  const callHistory = {};
  if (contactNames.length > 0) {
    const callResult = await pool.query(
      `SELECT lead_name, lead_company, COUNT(*) as call_count,
              MAX(created_at) as last_call,
              (array_agg(disposition ORDER BY created_at DESC))[1] as last_disposition
       FROM nucleus_phone_calls
       WHERE lead_name = ANY($1)
         AND (lead_company = ANY($2) OR lead_company IS NULL)
       GROUP BY lead_name, lead_company`,
      [contactNames, contactCompanies],
    );
    for (const row of callResult.rows) {
      // Key by name+company to avoid cross-company collisions
      const key = `${row.lead_name}::${row.lead_company || ''}`;
      callHistory[key] = {
        callCount: parseInt(row.call_count, 10),
        lastCall: row.last_call,
        lastDisposition: row.last_disposition,
      };
    }
  }

  // Group contacts by normalized company name
  const contactsByNorm = new Map();
  for (const c of contacts) {
    const norm = c.company_name_norm;
    if (!contactsByNorm.has(norm)) contactsByNorm.set(norm, []);
    contactsByNorm.get(norm).push({
      full_name: c.full_name,
      first_name: c.first_name,
      last_name: c.last_name,
      title: c.title,
      phone: c.phone || null,
      email: c.email || null,
      linkedin_url: c.linkedin_profile_url,
      location: c.location,
      source: c.source || 'phantombuster',
      call_history: callHistory[`${c.full_name}::${c.company_name || ''}`]
        || callHistory[`${c.full_name}::`] || null,
    });
  }

  // Batch: interaction count per company (single GROUP BY, not per-card)
  // Use LOWER() to handle case differences between sources
  const companyNames = companies.map(c => c.company_name).filter(Boolean);
  const interactionCounts = {};
  if (companyNames.length > 0) {
    const icResult = await pool.query(
      `SELECT LOWER(company_name) AS norm, COUNT(*)::int AS cnt
       FROM customer_interactions
       WHERE LOWER(company_name) = ANY($1)
       GROUP BY LOWER(company_name)`,
      [companyNames.map(n => n.toLowerCase())],
    );
    for (const row of icResult.rows) {
      interactionCounts[row.norm] = row.cnt;
    }
  }

  // Assemble result — companies with nested contacts
  const result = companies.map(company => {
    const norm = companyNorms.get(company.domain);
    const companyContacts = contactsByNorm.get(norm) || [];

    const withPhone = companyContacts.filter(c => c.phone);
    const withoutPhone = companyContacts.length - withPhone.length;

    // Sort: phone contacts first, then alphabetical
    const visibleContacts = has_phone ? withPhone : companyContacts;
    visibleContacts.sort((a, b) => {
      if (a.phone && !b.phone) return -1;
      if (!a.phone && b.phone) return 1;
      return (a.full_name || '').localeCompare(b.full_name || '');
    });

    return {
      ...company,
      contacts: visibleContacts,
      contact_count: companyContacts.length,
      phone_count: withPhone.length,
      no_phone_count: withoutPhone,
      interaction_count: interactionCounts[company.company_name?.toLowerCase()] || 0,
    };
  });

  // Filter out companies with no callable contacts when has_phone is true
  const filtered = has_phone ? result.filter(c => c.phone_count > 0) : result;

  return {
    companies: filtered,
    total,
  };
}

/**
 * Get all known contacts at a specific domain.
 * @param {string} domain
 * @returns {Promise<{ company: Object|null, contacts: Object[] }>}
 */
async function getContactsForDomain(domain) {
  const companyResult = await pool.query(
    `SELECT lr.domain, lr.company_name, lr.geo_state, lr.enrichment_status,
            sm.signal_tier, sm.signal_score, sm.source_count,
            sm.cert_expiry_date, sm.cert_standard, sm.contract_total, sm.dod_flag
     FROM v35_lead_reservoir lr
     LEFT JOIN v35_signal_metadata sm ON sm.domain = lr.domain
     WHERE lr.domain = $1
     LIMIT 1`,
    [domain],
  );

  if (companyResult.rows.length === 0) return { company: null, contacts: [] };
  const company = companyResult.rows[0];

  const norm = normalizeCompanyName(company.company_name);
  if (!norm) return { company, contacts: [] };

  const contactsResult = await pool.query(
    `SELECT full_name, first_name, last_name, title, company_name,
            linkedin_profile_url, location, industry, phone, source
     FROM v35_pb_contacts
     WHERE company_name_norm = $1
     ORDER BY full_name`,
    [norm],
  );

  // Enrich with call history, scoped to this company
  const names = contactsResult.rows.map(c => c.full_name).filter(Boolean);
  const callHistory = {};
  if (names.length > 0) {
    const callResult = await pool.query(
      `SELECT lead_name, COUNT(*) as call_count,
              MAX(created_at) as last_call,
              (array_agg(disposition ORDER BY created_at DESC))[1] as last_disposition
       FROM nucleus_phone_calls
       WHERE lead_name = ANY($1)
         AND (lead_company = $2 OR lead_company IS NULL)
       GROUP BY lead_name`,
      [names, company.company_name],
    );
    for (const row of callResult.rows) {
      callHistory[row.lead_name] = {
        callCount: parseInt(row.call_count, 10),
        lastCall: row.last_call,
        lastDisposition: row.last_disposition,
      };
    }
  }

  const contacts = contactsResult.rows.map(c => ({
    full_name: c.full_name,
    first_name: c.first_name,
    last_name: c.last_name,
    title: c.title,
    phone: c.phone || null,
    linkedin_url: c.linkedin_profile_url,
    location: c.location,
    source: c.source || 'phantombuster',
    call_history: callHistory[c.full_name] || null,
  }));

  // Phone contacts first
  contacts.sort((a, b) => {
    if (a.phone && !b.phone) return -1;
    if (!a.phone && b.phone) return 1;
    return (a.full_name || '').localeCompare(b.full_name || '');
  });

  return { company, contacts };
}

module.exports = { getSignalContacts, getContactsForDomain, buildSignalWhere };
