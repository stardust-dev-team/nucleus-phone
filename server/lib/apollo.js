/**
 * lib/apollo.js — Apollo API integration for identity resolution and contact enrichment.
 *
 * Three capabilities:
 * - matchPerson: single-person lookup by name/org (identity-resolver.js, 1 credit)
 * - searchPeopleByCompany: find contacts at a company (free search, no credits)
 * - revealPerson: get full contact details by Apollo ID (1 credit)
 *
 * Apollo's API is two-step: search (free, returns anonymized previews with has_phone/has_email flags)
 * → reveal via /people/match with ID (1 credit, returns full name, email, phone, LinkedIn).
 * searchPeopleByCompany handles both steps: searches, then reveals matching contacts.
 * With requestPhone=true (default): reveals only contacts with phone numbers (8 credits each).
 * With requestPhone=false: reveals all matching contacts for email-only enrichment (1 credit each).
 */

const BASE_URL = 'https://api.apollo.io/api/v1';
const TIMEOUT_MS = 15000;
const PHONE_REVEAL_CREDIT_COST = 8; // Apollo charges 8 credits for mobile phone reveals

/**
 * Extract a direct/mobile phone from Apollo's phone_numbers array.
 * Returns null if only corporate/HQ numbers are available.
 * sanitized_phone on the person object is always the org's main line — never use it.
 */
function pickDirectPhone(phoneNumbers) {
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) return null;
  const direct = phoneNumbers.find(p =>
    (p.type_cd === 'mobile' || p.type_cd === 'direct' || p.type === 'mobile' || p.type === 'direct')
    && p.status_cd !== 'invalid_number',
  );
  if (direct?.sanitized_number) return direct.sanitized_number;
  // Only fall back to non-corporate types — skip 'work'/'other' which are usually HQ lines
  return null;
}

// Title filters for CNC manufacturing personas (from North Star Spear sequence)
const DEFAULT_TITLE_FILTERS = [
  'VP Operations', 'Director of Operations',
  'Director of Quality', 'Quality Manager',
  'Plant Manager', 'General Manager',
  'Purchasing Manager', 'Procurement Director',
  'Maintenance Director',
  'CFO', 'Owner',
];

/**
 * Match a person by name + organization. Returns full person object or null.
 * Consumes 1 Apollo credit.
 */
async function matchPerson({ firstName, lastName, organization, email }) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  const body = {
    first_name: firstName,
    last_name: lastName,
    organization_name: organization,
    ...(email && { email }),
  };

  const resp = await fetch(`${BASE_URL}/people/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo match failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  return data.person || null;
}

// Webhook URL for async phone number delivery from Apollo
const PHONE_WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';

/**
 * Reveal a person's full contact details by Apollo ID.
 * Consumes 1 credit (email only) or 8 credits (with phone reveal).
 * Phone numbers are delivered asynchronously via webhook — the synchronous
 * response contains name, email, title, LinkedIn but NOT phone.
 *
 * @param {string} apolloId - Apollo person ID from search results
 * @param {boolean} [requestPhone] - Request async phone delivery via webhook (default true)
 * @returns {Promise<{apollo_person_id, name, first_name, last_name, title, phone, email, linkedin_url}|null>}
 */
async function revealPerson(apolloId, requestPhone = true) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return null;

  const body = { id: apolloId, reveal_personal_emails: false };
  if (requestPhone) {
    body.reveal_phone_number = true;
    body.webhook_url = PHONE_WEBHOOK_URL;
  }

  const resp = await fetch(`${BASE_URL}/people/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Apollo reveal failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  const p = data.person;
  if (!p) return null;

  return {
    apollo_person_id: p.id || null,
    name: p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    first_name: p.first_name || null,
    last_name: p.last_name || null,
    title: p.title || null,
    phone: pickDirectPhone(p.phone_numbers),
    email: p.email || null,
    linkedin_url: p.linkedin_url || null,
  };
}

/**
 * Search for people at a company, then reveal those with phone numbers.
 *
 * Step 1 (free): /mixed_people/api_search — returns anonymized previews with has_direct_phone flag
 * Step 2 (credits): /people/match with ID — reveals contacts (8 credits with phone, 1 without)
 *
 * Credit cost depends on requestPhone flag. Phone mode: only reveals contacts with phones.
 *
 * @param {string} domain - Company domain
 * @param {Object} [opts] - Options
 * @param {string[]} [opts.titleFilters] - Job titles to filter by
 * @param {number} [opts.perPage] - Max search results (default 10)
 * @param {boolean} [opts.requestPhone] - Request phone reveals (8 credits) vs email-only (1 credit). Default true.
 * @returns {Promise<{previews: Object[], contacts: Object[], creditsUsed: number}>}
 */
async function searchPeopleByCompany(domain, { titleFilters = DEFAULT_TITLE_FILTERS, perPage = 10, requestPhone = true } = {}) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) return { previews: [], contacts: [], creditsUsed: 0 };

  // Step 1: Resolve domain → Apollo org ID (free, no credits)
  const orgResp = await fetch(`${BASE_URL}/organizations/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ q_organization_domains: domain, per_page: 1 }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!orgResp.ok) {
    const text = await orgResp.text().catch(() => '');
    throw new Error(`Apollo org search failed: ${orgResp.status} ${text.substring(0, 200)}`);
  }

  const orgData = await orgResp.json();
  const org = orgData.organizations?.[0];
  if (!org?.id) return { previews: [], contacts: [], creditsUsed: 0 };

  // Verify domain match — reject if Apollo returns a different org
  const orgDomain = (org.primary_domain || '').toLowerCase();
  if (orgDomain && orgDomain !== domain.toLowerCase()) {
    return { previews: [], contacts: [], creditsUsed: 0 };
  }

  // Step 2: Search people by org ID + title filters (free search)
  const searchResp = await fetch(`${BASE_URL}/mixed_people/api_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      organization_ids: [org.id],
      person_titles: titleFilters,
      page: 1,
      per_page: Math.min(perPage, 25),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!searchResp.ok) {
    const text = await searchResp.text().catch(() => '');
    throw new Error(`Apollo people search failed: ${searchResp.status} ${text.substring(0, 200)}`);
  }

  const searchData = await searchResp.json();
  const previews = searchData.people || [];

  // Step 3: Reveal contacts
  // Phone mode (8 credits): only reveal contacts with phone numbers
  // Email-only mode (1 credit): reveal all matching contacts
  const toReveal = requestPhone
    ? previews.filter(p => p.has_direct_phone === 'Yes')
    : previews;
  const creditCost = requestPhone ? PHONE_REVEAL_CREDIT_COST : 1;
  const contacts = [];
  let creditsUsed = 0;

  for (const preview of toReveal) {
    try {
      const revealed = await revealPerson(preview.id, requestPhone);
      if (revealed) {
        contacts.push(revealed);
        creditsUsed += creditCost;
      }
    } catch (err) {
      console.error(`Failed to reveal ${preview.id}:`, err.message);
    }
  }

  return { previews, contacts, creditsUsed };
}

module.exports = { matchPerson, revealPerson, searchPeopleByCompany, DEFAULT_TITLE_FILTERS, PHONE_REVEAL_CREDIT_COST };
