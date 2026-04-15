/**
 * lib/identity-resolver-inline.js — LEGACY inline resolution chain.
 *
 * Preserved ONLY as a fallback for when the UCIL hub is unreachable
 * (see identity-resolver.js for the primary hub-client path).
 *
 * This module runs the FREE portions of the chain: HubSpot lookup,
 * v35_pb_contacts lookup, and LinkedIn slug name parsing. Paid Apollo
 * and Dropcontact enrichments are intentionally DISABLED here to avoid
 * double-spending against the same daily credit counter the hub owns
 * (see joruva-ucil/src/lib/hub/credit-budget.js). A hub outage is a
 * degraded mode — we serve the cached/free data we have and wait for
 * the hub to come back rather than blowing through the credit budget
 * with uncoordinated calls.
 */

const { pool } = require('../db');
const { normalizePhone } = require('./phone');
const { normalizeCompanyName } = require('./company-normalizer');
const { findContactByPhone, getContact, searchContacts } = require('./hubspot');
// Apollo + Dropcontact imports deliberately removed — see header comment.
// The hub (UCIL) is the sole owner of paid enrichment budget.

// Frozen mirror of UCIL contact-resolver.buildFullName. Do NOT evolve this
// implementation — behavior changes belong in the canonical hub copy at
// /Users/Shared/joruva-ucil/src/lib/hub/contact-resolver.js. This file is a
// legacy fallback; drift here goes unnoticed because each repo only tests
// its local copy.
function buildFullName(firstName, lastName) {
  const f = firstName || null;
  const l = lastName || null;
  if (f && l && f.toLowerCase().endsWith(l.toLowerCase())) return f;
  return [f, l].filter(Boolean).join(' ') || null;
}

/**
 * Extract full name from LinkedIn URL slug. Free, instant, no API calls.
 * "linkedin.com/in/ashley-parker8190" + firstName "Ashley" → { firstName: "Ashley", lastName: "Parker" }
 */
function resolveNameFromSlug(url, firstName) {
  if (!url || !firstName) return null;
  const slug = url.match(/linkedin\.com\/in\/([^/?]+)/)?.[1];
  if (!slug) return null;

  const clean = slug
    .replace(/-[a-f0-9]{6,}$/, '')
    .replace(/-?\d+$/, '')
    .replace(/-(mba|phd|pe|cpa|pmp|cfa|csm|ehs|mfg-leader|plant-manager|strategic-advisor|engineering|mgr|aeromgr)$/i, '');

  const firstLower = firstName.toLowerCase();

  // Hyphenated: "ashley-parker" → Ashley Parker
  const parts = clean.split('-');
  if (parts.length >= 2 && parts[0].toLowerCase() === firstLower) {
    const last = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    if (last.length >= 2) return { firstName: capitalize(parts[0]), lastName: last };
  }

  // Concatenated: "ashleyparker" → Ashley Parker
  const lower = clean.toLowerCase();
  if (lower.startsWith(firstLower) && lower.length > firstLower.length + 1) {
    const rest = clean.slice(firstLower.length);
    if (rest.length >= 3 && rest.length <= 20 && /^[a-z]+$/i.test(rest)) {
      return { firstName: capitalize(firstLower), lastName: capitalize(rest) };
    }
  }

  return null;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

/** Convert normalized digits to E.164. Assumes US (+1) for 10-digit numbers. */
function toE164(phone) {
  if (!phone) return null;
  if (phone.startsWith('+')) return phone;
  if (phone.length === 10) return `+1${phone}`;
  if (phone.length === 11 && phone.startsWith('1')) return `+${phone}`;
  console.warn('toE164: unexpected phone length', phone.length, phone);
  return null; // Unknown format — return null rather than non-E.164 string
}

/**
 * Resolve an identifier (phone, email, or HubSpot contact ID) into a
 * unified identity with rapport data from HubSpot + PB contacts.
 *
 * @param {string} identifier - phone number, email, or HubSpot contact ID
 * @returns {Promise<ResolvedIdentity>}
 */
async function resolve(identifier) {
  if (!identifier) return unresolved(identifier);

  const type = classifyIdentifier(identifier);
  if (type === 'unknown') return unresolved(identifier);

  let hsContact = null;

  // Step 1: HubSpot lookup
  try {
    if (type === 'phone') {
      hsContact = await findContactByPhone(identifier);
    } else if (type === 'hubspot_id') {
      hsContact = await getContact(identifier);
    } else if (type === 'email') {
      const result = await searchContacts(identifier, 1);
      hsContact = result.total > 0 ? result.results[0] : null;
    }
  } catch (err) {
    console.warn('Identity resolver: HubSpot lookup failed:', err.message);
  }

  const props = hsContact?.properties || {};
  // Frozen behavior mirror of UCIL contact-resolver.buildFullName. Do NOT
  // evolve this — this module is a legacy fallback. Behavior changes belong
  // in /Users/Shared/joruva-ucil/src/lib/hub/contact-resolver.js.
  let name = buildFullName(props.firstname, props.lastname);
  let company = props.company || null;
  const phone = normalizePhone(identifier) || normalizePhone(props.phone) || null;

  let pbData = null;

  // Step 1b: If HubSpot didn't find the contact, try v35_pb_contacts by phone or email.
  // Apollo/Dropcontact-enriched PB contacts may not be in HubSpot yet.
  if (!hsContact && (phone || type === 'phone')) {
    try {
      const pbByPhone = await lookupPbContactByPhone(identifier, phone);
      if (pbByPhone) {
        name = name || pbByPhone.full_name;
        company = company || pbByPhone.company_name;
      }
    } catch (err) {
      console.warn('Identity resolver: PB phone lookup failed:', err.message);
    }
  }

  // Step 1c: Email-based PB lookup (Apollo-enriched contacts with email but not in HubSpot)
  if (!hsContact && !name && type === 'email') {
    try {
      const { rows } = await pool.query(
        `SELECT full_name, first_name, last_name, title, company_name, domain,
                linkedin_profile_url, phone, email
         FROM v35_pb_contacts WHERE email = $1 LIMIT 1`,
        [identifier.toLowerCase()]
      );
      if (rows[0]) {
        name = rows[0].full_name;
        company = rows[0].company_name;
        // Pre-seed pbData so step 2 doesn't re-query
        pbData = {
          full_name: rows[0].full_name,
          title: rows[0].title,
          linkedinUrl: rows[0].linkedin_profile_url,
          company: rows[0].company_name,
          domain: rows[0].domain,
        };
      }
    } catch (err) {
      console.warn('Identity resolver: PB email lookup failed:', err.message);
    }
  }

  // Step 2: PB contacts lookup by company + name (enriches with LinkedIn, title, etc.)
  // pbData may already be set from step 1c (email-based PB lookup)
  if (!pbData && company && name) {
    try {
      pbData = await lookupPbContact(company, name);
    } catch (err) {
      console.warn('Identity resolver: PB lookup failed:', err.message);
    }
  }

  // Step 2c: If last name is truncated ("P." from Sales Navigator), try URL slug first (free)
  const lastNameParts = (name || '').split(/\s+/).slice(1);
  let lastNameTruncated = lastNameParts.length > 0 && /^\w\.$/.test(lastNameParts[lastNameParts.length - 1]);
  const slugUrl = pbData?.linkedinUrl || pbData?.defaultProfileUrl || null;
  if (lastNameTruncated && name && slugUrl) {
    const resolved = resolveNameFromSlug(slugUrl, name.split(/\s+/)[0]);
    if (resolved) {
      name = `${resolved.firstName} ${resolved.lastName}`;
      lastNameTruncated = false; // Resolved — skip Apollo
      // Persist the fix back to PB contacts, scoped by LinkedIn URL (unique)
      pool.query(
        `UPDATE v35_pb_contacts SET full_name = $1, first_name = $2, last_name = $3
         WHERE first_name = $4 AND last_name ~ '^\\w\\.$' AND company_name_norm = $5
           AND linkedin_profile_url = $6`,
        [name, resolved.firstName, resolved.lastName, resolved.firstName, normalizeCompanyName(company), slugUrl]
      ).catch(err => console.warn('identity-resolver: slug name persist failed:', err.message));
    }
  }

  // Steps 3 & 4 (Apollo + Dropcontact) INTENTIONALLY DISABLED in the inline
  // fallback — the UCIL hub owns the credit budget. A hub outage is a
  // degraded mode: we serve HubSpot + PB data and let the hub handle paid
  // enrichment when it's back. See header comment for rationale.
  const resolvedEmail = props.email || null;

  if (!hsContact && !pbData) {
    return unresolved(identifier);
  }

  const source = hsContact ? 'hubspot' : 'pb_contacts';

  return {
    resolved: true,
    hubspotContactId: hsContact?.id || null,
    hubspotCompanyId: props.associatedcompanyid || null,
    name,
    email: resolvedEmail || null,
    phone: toE164(phone),
    company,
    title: pbData?.title || props.jobtitle || null,
    linkedinUrl: pbData?.linkedinUrl || null,
    profileImage: pbData?.profileImage || null,
    pbContactData: pbData ? {
      summary: pbData.summary,
      industry: pbData.industry,
      location: pbData.location,
      companyLocation: pbData.companyLocation,
      durationInRole: pbData.durationInRole,
      durationInCompany: pbData.durationInCompany,
      pastExperience: pbData.pastExperience,
      connectionDegree: pbData.connectionDegree,
    } : null,
    fitScore: props.joruva_fit_score || null,
    fitReason: props.joruva_fit_reason || null,
    persona: props.joruva_persona || null,
    source,
  };
}

/**
 * Classify identifier as phone, email, or HubSpot contact ID.
 */
function classifyIdentifier(id) {
  if (id.includes('@')) return 'email';
  // Pure digits with no formatting → HubSpot contact ID (they're numeric strings like "357584127732")
  // Phone numbers from the dialer always have formatting: +1, parens, dashes, or spaces
  if (/^\d+$/.test(id)) return 'hubspot_id';
  // Has phone formatting characters (+, parens, dashes, dots, spaces) with 7+ digits
  const digits = id.replace(/\D/g, '');
  if (/^[+\d().\s-]+$/.test(id) && digits.length >= 7) return 'phone';
  return 'unknown';
}

/**
 * Query v35_pb_contacts by normalized company name, then filter by name.
 *
 * Matching rules (from plan review):
 * - Query by company_name_norm first (indexed)
 * - Filter by name similarity: exact > first+last > first-only
 * - If company returns >5 rows with no name match, skip (false positive risk)
 * - NEVER return PB data without both company AND name matching
 */
async function lookupPbContact(company, name) {
  const companyNorm = normalizeCompanyName(company);
  if (!companyNorm) return null;

  const { rows } = await pool.query(`
    SELECT full_name, first_name, last_name, title, industry, location,
           linkedin_profile_url,
           raw_data->>'profileImageUrl' AS profile_image,
           raw_data->>'defaultProfileUrl' AS default_profile_url,
           raw_data->>'summary' AS summary,
           raw_data->>'durationInRole' AS duration_in_role,
           raw_data->>'durationInCompany' AS duration_in_company,
           raw_data->>'connectionDegree' AS connection_degree,
           raw_data->>'pastExperienceCompanyName' AS past_company,
           raw_data->>'pastExperienceCompanyTitle' AS past_title,
           raw_data->>'pastExperienceDuration' AS past_experience_duration,
           raw_data->>'companyLocation' AS company_location
    FROM v35_pb_contacts
    WHERE company_name_norm = $1
    LIMIT 20
  `, [companyNorm]);

  if (!rows.length) return null;

  const nameParts = name.toLowerCase().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Rank matches by quality
  let best = null;
  let bestScore = 0;

  for (const row of rows) {
    const rowFirst = (row.first_name || '').toLowerCase();
    const rowLast = (row.last_name || '').toLowerCase();
    const rowFull = (row.full_name || '').toLowerCase();

    let score = 0;
    // Exact full name match
    if (rowFull === name.toLowerCase()) {
      score = 3;
    // First + last match
    } else if (rowFirst === firstName && lastName && rowLast === lastName) {
      score = 2;
    // First name only match (weak — only if few results)
    } else if (rowFirst === firstName && rows.length <= 5) {
      score = 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  // No name match at all — refuse to return (wrong person's photo is worse than no photo)
  if (!best) return null;

  return {
    title: best.title,
    industry: best.industry,
    location: best.location,
    linkedinUrl: best.linkedin_profile_url,
    defaultProfileUrl: best.default_profile_url,
    profileImage: best.profile_image,
    summary: best.summary,
    durationInRole: best.duration_in_role,
    durationInCompany: best.duration_in_company,
    connectionDegree: best.connection_degree,
    companyLocation: best.company_location,
    pastExperience: best.past_company ? {
      company: best.past_company,
      title: best.past_title,
      duration: best.past_experience_duration,
    } : null,
  };
}

/**
 * Look up a PB contact by phone number. Used when HubSpot doesn't know the contact
 * but Dropcontact enriched them with a phone number in v35_pb_contacts.
 */
async function lookupPbContactByPhone(rawPhone, normalizedPhone) {
  // Try exact match on raw phone first (e.g. "+1 734-656-2200" — uses idx_pbc_phone index)
  const { rows } = await pool.query(`
    SELECT full_name, first_name, last_name, title, company_name, phone,
           linkedin_profile_url
    FROM v35_pb_contacts
    WHERE phone = $1 OR phone = $2
    LIMIT 1
  `, [rawPhone, normalizedPhone || rawPhone]);

  if (rows.length > 0) return rows[0];

  // Fuzzy: last 7 digits suffix match (handles +1 vs 1, spaces vs dashes)
  const digits = (rawPhone || '').replace(/\D/g, '');
  if (digits.length < 7) return null;

  const { rows: fuzzyRows } = await pool.query(`
    SELECT full_name, first_name, last_name, title, company_name, phone,
           linkedin_profile_url
    FROM v35_pb_contacts
    WHERE phone_suffix7 = $1
    LIMIT 1
  `, [digits.slice(-7)]);

  return fuzzyRows[0] || null;
}

function unresolved(identifier) {
  return {
    resolved: false,
    hubspotContactId: null,
    hubspotCompanyId: null,
    name: null,
    email: null,
    phone: toE164(normalizePhone(identifier)),
    company: null,
    title: null,
    linkedinUrl: null,
    profileImage: null,
    pbContactData: null,
    fitScore: null,
    fitReason: null,
    persona: null,
    source: 'unknown',
  };
}

module.exports = { resolve, toE164 };
