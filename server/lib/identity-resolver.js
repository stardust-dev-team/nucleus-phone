/**
 * lib/identity-resolver.js — Phone/email/ID → unified ResolvedIdentity.
 *
 * Steps 1-2 (free): HubSpot + PB contacts.
 * Steps 3-4 (credit-gated): Apollo + Dropcontact.
 */

const { pool } = require('../db');
const { normalizePhone } = require('./phone');
const { normalizeCompanyName } = require('./company-normalizer');
const { findContactByPhone, getContact, searchContacts } = require('./hubspot');
const { matchPerson } = require('./apollo');
const { reverseSearch } = require('./dropcontact');

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
  let name = [props.firstname, props.lastname].filter(Boolean).join(' ') || null;
  let company = props.company || null;
  const phone = normalizePhone(identifier) || normalizePhone(props.phone) || null;

  // Step 1b: If HubSpot didn't find the contact, try v35_pb_contacts by phone number.
  // Dropcontact-enriched PB contacts have phone numbers but aren't in HubSpot.
  if (!hsContact && phone) {
    try {
      const pbByPhone = await lookupPbContactByPhone(phone);
      if (pbByPhone) {
        name = name || pbByPhone.full_name;
        company = company || pbByPhone.company_name;
      }
    } catch (err) {
      console.warn('Identity resolver: PB phone lookup failed:', err.message);
    }
  }

  // Step 2: PB contacts lookup by company + name (enriches with LinkedIn, title, etc.)
  let pbData = null;
  if (company && name) {
    try {
      pbData = await lookupPbContact(company, name);
    } catch (err) {
      console.warn('Identity resolver: PB lookup failed:', err.message);
    }
  }

  // Step 3: Apollo people match (credit-gated, only if name known but need more data)
  let apolloData = null;
  if (name && company && !pbData?.linkedinUrl) {
    try {
      if (await checkCreditBudget('apollo')) {
        const nameParts = name.split(/\s+/);
        const person = await matchPerson({
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' '),
          organization: company,
          email: props.email || undefined,
        });
        if (person) {
          apolloData = {
            linkedinUrl: person.linkedin_url || null,
            title: person.title || null,
            email: person.email || null,
          };
        }
      }
    } catch (err) {
      console.warn('Identity resolver: Apollo match failed:', err.message);
    }
  }

  // Step 4: Dropcontact reverse search (credit-gated, only if no email from Steps 1-3)
  let dropcontactEmail = null;
  const resolvedEmail = props.email || apolloData?.email || null;
  if (!resolvedEmail && phone && name) {
    try {
      if (await checkCreditBudget('dropcontact')) {
        const nameParts = name.split(/\s+/);
        const dc = await reverseSearch({
          phone,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' '),
          company: company || undefined,
        });
        dropcontactEmail = dc.email;
      }
    } catch (err) {
      console.warn('Identity resolver: Dropcontact search failed:', err.message);
    }
  }

  if (!hsContact && !pbData && !apolloData && !dropcontactEmail) {
    return unresolved(identifier);
  }

  const source = hsContact ? 'hubspot'
    : pbData ? 'pb_contacts'
    : apolloData ? 'apollo'
    : 'dropcontact';

  return {
    resolved: true,
    hubspotContactId: hsContact?.id || null,
    hubspotCompanyId: props.associatedcompanyid || null,
    name,
    email: resolvedEmail || dropcontactEmail || null,
    phone,
    company,
    title: pbData?.title || apolloData?.title || props.jobtitle || null,
    linkedinUrl: pbData?.linkedinUrl || apolloData?.linkedinUrl || null,
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

/**
 * Look up a PB contact by phone number. Used when HubSpot doesn't know the contact
 * but Dropcontact enriched them with a phone number in v35_pb_contacts.
 */
async function lookupPbContactByPhone(phone) {
  // Try exact match first (uses idx_pbc_phone index), then fuzzy suffix match
  const { rows } = await pool.query(`
    SELECT full_name, first_name, last_name, title, company_name, phone,
           linkedin_profile_url
    FROM v35_pb_contacts
    WHERE phone = $1
    LIMIT 1
  `, [phone]);

  if (rows.length > 0) return rows[0];

  // Fuzzy: strip to digits, match by suffix (handles format differences like +1 vs 1)
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;

  const { rows: fuzzyRows } = await pool.query(`
    SELECT full_name, first_name, last_name, title, company_name, phone,
           linkedin_profile_url
    FROM v35_pb_contacts
    WHERE phone IS NOT NULL AND phone LIKE '%' || $1
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

/**
 * Atomic credit budget guard via UPDATE ... RETURNING.
 * Prevents TOCTOU race on concurrent cockpit loads.
 */
async function checkCreditBudget(service, dailyLimit = 10) {
  const syncKey = `${service}_daily_credits`;
  const today = new Date().toISOString().slice(0, 10);

  // Atomic: increment if under budget, reset if new day. Returns new count.
  const { rows } = await pool.query(`
    INSERT INTO ucil_sync_state (sync_key, last_sync_at, metadata)
    VALUES ($1, NOW(), jsonb_build_object('date', $2::text, 'credits_used', 1))
    ON CONFLICT (sync_key) DO UPDATE SET
      metadata = CASE
        WHEN ucil_sync_state.metadata->>'date' = $2
          AND (ucil_sync_state.metadata->>'credits_used')::int >= $3
        THEN ucil_sync_state.metadata  -- over budget: don't increment
        WHEN ucil_sync_state.metadata->>'date' = $2
        THEN jsonb_build_object('date', $2::text, 'credits_used',
             ((ucil_sync_state.metadata->>'credits_used')::int + 1))
        ELSE jsonb_build_object('date', $2::text, 'credits_used', 1)  -- new day: reset
      END,
      updated_at = NOW()
    RETURNING metadata
  `, [syncKey, today, dailyLimit]);

  const meta = rows[0]?.metadata || {};
  const used = parseInt(meta.credits_used, 10) || 0;

  if (used >= dailyLimit) {
    console.log(`Credit budget exhausted for ${service}: ${used}/${dailyLimit}`);
    return false;
  }

  return true;
}

module.exports = { resolve };
