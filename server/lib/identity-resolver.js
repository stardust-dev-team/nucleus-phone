/**
 * lib/identity-resolver.js — Phone/email/ID → unified ResolvedIdentity.
 *
 * Steps 1-2 (free): HubSpot + PB contacts.
 * Steps 3-4 (credit-gated): Apollo + Dropcontact — added in Bead 9.
 */

const { pool } = require('../db');
const { normalizePhone } = require('./phone');
const { normalizeCompanyName } = require('./company-normalizer');
const { findContactByPhone, getContact, searchContacts } = require('./hubspot');

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
  const name = [props.firstname, props.lastname].filter(Boolean).join(' ') || null;
  const company = props.company || null;
  const phone = normalizePhone(identifier) || normalizePhone(props.phone) || null;

  // Step 2: PB contacts lookup (requires company + name from Step 1)
  let pbData = null;
  if (company && name) {
    try {
      pbData = await lookupPbContact(company, name);
    } catch (err) {
      console.warn('Identity resolver: PB lookup failed:', err.message);
    }
  }

  if (!hsContact && !pbData) return unresolved(identifier);

  return {
    resolved: true,
    hubspotContactId: hsContact?.id || null,
    hubspotCompanyId: props.associatedcompanyid || null,
    name,
    email: props.email || null,
    phone,
    company,
    title: pbData?.title || props.jobtitle || null,
    linkedinUrl: pbData?.linkedinUrl || null,
    profileImage: pbData?.profileImage || null,
    pbContactData: pbData ? {
      summary: pbData.summary,
      durationInRole: pbData.durationInRole,
      durationInCompany: pbData.durationInCompany,
      pastExperience: pbData.pastExperience,
      connectionDegree: pbData.connectionDegree,
    } : null,
    fitScore: props.joruva_fit_score || null,
    fitReason: props.joruva_fit_reason || null,
    persona: props.joruva_persona || null,
    source: hsContact ? 'hubspot' : 'pb_contacts',
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
  return 'hubspot_id';
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
           raw_data->>'summary' AS summary,
           raw_data->>'durationInRole' AS duration_in_role,
           raw_data->>'durationInCompany' AS duration_in_company,
           raw_data->>'connectionDegree' AS connection_degree,
           raw_data->>'pastExperienceCompanyName' AS past_company,
           raw_data->>'pastExperienceCompanyTitle' AS past_title
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
    linkedinUrl: best.linkedin_profile_url,
    profileImage: best.profile_image,
    summary: best.summary,
    durationInRole: best.duration_in_role,
    durationInCompany: best.duration_in_company,
    connectionDegree: best.connection_degree,
    pastExperience: best.past_company ? {
      company: best.past_company,
      title: best.past_title,
    } : null,
  };
}

function unresolved(identifier) {
  return {
    resolved: false,
    hubspotContactId: null,
    hubspotCompanyId: null,
    name: null,
    email: null,
    phone: normalizePhone(identifier),
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

module.exports = { resolve };
