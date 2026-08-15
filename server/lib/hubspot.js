const { normalizePhone } = require('./phone');
const { throwHttpError } = require('./http-error');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 3;
// 5xx backoff (nucleus-phone-ju8): exponential, jittered, capped. 429 keeps its own
// retry-after honoring path; this governs only the transient-5xx retries.
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 8000;
// Ceiling on a SERVER-SUPPLIED Retry-After (post-merge C3). RETRY_CAP_MS bounds
// only our own backoff; honoring the header unbounded let a remote value hang a
// request handler — `Retry-After: 900` meant three 15-minute sleeps, and
// server/index.js sets no request timeout, so GET /api/contacts/lookup (which
// chains four hubspotFetch calls, each with a fresh budget) could hold a socket
// for the better part of an hour on an ordinary `Retry-After: 60`. Wait at most
// this long per attempt no matter what the server asks for.
const RETRY_AFTER_CAP_MS = 30000;

/** Parse a Retry-After delta-seconds header into bounded ms; 0 if unusable.
 *  RFC 7231 also permits an HTTP-date form, which parseInt yields NaN for —
 *  hence the isFinite guard rather than a bare parseInt (see the 429 path). */
function retryAfterMs(resp) {
  const secs = parseInt(resp.headers.get('retry-after') || '', 10);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
}

// Full-jitter capped exponential backoff — the AWS-recommended anti-stampede: a uniform
// pick in [0, min(cap, base·2^attempt)] FULLY decorrelates retries across many CRM writes
// that hit the same LB bounce / pod restart at once (additive-only jitter would still
// synchronize the exponential component).
/** Release the socket before recursing. undici holds an unread body until GC. */
async function discardBody(resp) {
  try { await resp.body?.cancel(); } catch { /* already consumed or absent */ }
}

function backoffMs(attempt) {
  const expo = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * expo);
}

// CONTACT_PROPERTIES must remain a module-level constant — never user-supplied.
const CONTACT_PROPERTIES = [
  'firstname', 'lastname', 'company', 'phone', 'mobilephone',
  'email', 'jobtitle', 'city', 'state', 'hs_lead_status',
  'notes_last_updated', 'associatedcompanyid',
  'joruva_fit_score', 'joruva_fit_reason', 'joruva_persona',
].join(',');

function headers() {
  return {
    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * `options.idempotent` (nucleus-phone-ju8, hardened during the PR #11 salvage):
 * opt a POST into 5xx retries. Default is NO retry for POST — see the 5xx
 * branch. Destructured out of `init` so it never rides into fetch() as a junk
 * key.
 *
 * BODY MUST BE A STRING. Every call site passes JSON.stringify(...), which is
 * freely re-sendable; a ReadableStream or streaming FormData would be consumed
 * by the first attempt and throw on re-send.
 *
 * `headers()` is re-evaluated on each attempt, so a token rotated mid-retry is
 * picked up. That is deliberate — do not "optimize" it by hoisting the call.
 *
 * `_retries` is a SHARED budget across the 429 and 5xx paths: an alternating
 * 429/503 sequence exhausts after MAX_RETRIES total, not MAX_RETRIES each.
 * That is intended — it is a total attempt cap, not a per-cause one.
 */
async function hubspotFetch(path, options = {}, _retries = 0) {
  const url = `${HUBSPOT_BASE}${path}`;
  const { idempotent, ...init } = options;
  const method = init.method || 'GET';
  const resp = await fetch(url, {
    ...init,
    headers: { ...headers(), ...init.headers },
  });

  if (resp.status === 429) {
    if (_retries >= MAX_RETRIES) {
      // Structured error so callers can branch on err.status === 429 even
      // after the retry loop gave up.
      const text = await resp.text().catch(() => '');
      throwHttpError(resp, text, method, path, { service: 'HubSpot' });
    }
    // Math.max(1, parseInt(...)) propagated NaN on the RFC-legal HTTP-date form
    // of Retry-After, and Node coerces setTimeout(fn, NaN) to 1ms — four
    // requests ~1ms apart at an endpoint that had just rate-limited us
    // (post-merge C4). Fall back to the documented 2s default instead, and cap
    // the honored value the same way the 5xx path does.
    const waitMs = retryAfterMs(resp) || 2000;
    await new Promise(r => setTimeout(r, waitMs));
    await discardBody(resp);
    return hubspotFetch(path, options, _retries + 1);
  }

  // 5xx retry (nucleus-phone-ju8). 4xx other than 429 fall through to the throw
  // below — those are client-side and will not fix themselves on a retry.
  //
  // SCOPE, honestly: total worst-case backoff is 500+1000+2000 = 3.5s, and full
  // jitter makes the EXPECTED total ~1.75s. That covers a sub-second LB
  // rotation or a Cloudflare hiccup. It does NOT survive a pod restart (5-30s);
  // raising MAX_RETRIES / RETRY_BASE_MS would be a separate, deliberate call.
  //
  // NOT FOR POST CREATES. HubSpot's CRM v3 object API has no idempotency-key
  // header, and a 504 in particular usually means the gateway gave up while the
  // write LANDED. Retrying POST /deals would create a second deal; retrying
  // POST /contacts would create a second contact for a phone-only lead (HubSpot
  // dedupes on email, and these leads are phone-first), after which
  // findContactByPhone's `limit: 1` scatters later notes and deals
  // nondeterministically across the duplicates. Silent CRM corruption is worse
  // than a failed write, so POST is deny-by-default and the read-only /search
  // POSTs opt in explicitly with `idempotent: true`.
  const retry5xx = idempotent ?? (method !== 'POST');
  if (resp.status >= 500 && retry5xx) {
    if (_retries >= MAX_RETRIES) {
      const text = await resp.text().catch(() => '');
      throwHttpError(resp, text, method, path, { service: 'HubSpot' });
    }
    // Honor Retry-After when the server sends one (RFC 7231 defines it for 503).
    // Our own backoff peaks at 2s; if HubSpot says "30s" during a real outage,
    // hammering would burn the whole budget in under two seconds.
    const waitMs = Math.max(backoffMs(_retries), retryAfterMs(resp));
    await new Promise(r => setTimeout(r, waitMs));
    await discardBody(resp);
    return hubspotFetch(path, options, _retries + 1);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throwHttpError(resp, text, method, path, { service: 'HubSpot' });
  }

  return resp.status === 204 ? null : resp.json();
}

async function searchContacts(query, limit = 50, after) {
  const body = {
    filterGroups: [],
    properties: CONTACT_PROPERTIES.split(','),
    limit,
    ...(after && { after }),
  };
  if (query) body.query = query;

  return hubspotFetch('/crm/v3/objects/contacts/search', {
    // POST, but read-only — safe to retry on 5xx (see hubspotFetch).
    idempotent: true,
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function getContact(contactId) {
  return hubspotFetch(
    `/crm/v3/objects/contacts/${contactId}?properties=${CONTACT_PROPERTIES}`
  );
}

async function addNoteToContact(contactId, noteBody) {
  return hubspotFetch('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: noteBody,
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
      ],
    }),
  });
}

/**
 * Search for contact by phone/mobilephone with EQ + CONTAINS_TOKEN fallback.
 */
async function findContactByPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const last7 = normalized.length >= 7 ? normalized.slice(-7) : null;
  const filters = [
    { propertyName: 'phone', operator: 'EQ', value: normalized },
    { propertyName: 'mobilephone', operator: 'EQ', value: normalized },
    ...(last7 ? [
      { propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: last7 },
      { propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: last7 },
    ] : []),
  ];

  for (const filter of filters) {
    const result = await hubspotFetch('/crm/v3/objects/contacts/search', {
      // POST, but read-only — safe to retry on 5xx (see hubspotFetch).
      idempotent: true,
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [filter] }],
        properties: CONTACT_PROPERTIES.split(','),
        limit: 1,
      }),
    });
    if (result.total > 0) return result.results[0];
  }

  return null;
}

/**
 * Create or update a HubSpot contact. Returns { id, isNew }.
 */
async function upsertContact(lead, { ucilSource = 'nucleus_phone' } = {}) {
  const existing = await findContactByPhone(lead.phone);

  const nameParts = (lead.name || '').split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const props = {
    ...(firstName && { firstname: firstName }),
    ...(lastName && { lastname: lastName }),
    ...(lead.email && { email: lead.email }),
    ...(lead.phone && { phone: lead.phone }),
    ...(lead.company && { company: lead.company }),
    ucil_source: ucilSource,
  };

  if (existing) {
    await hubspotFetch(`/crm/v3/objects/contacts/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: props }),
    });
    return { id: existing.id, isNew: false };
  }

  const created = await hubspotFetch('/crm/v3/objects/contacts', {
    method: 'POST',
    body: JSON.stringify({ properties: props }),
  });
  return { id: created.id, isNew: true };
}

/**
 * Create a deal associated with a contact.
 */
async function createDeal({ contactId, dealName, notes, stage, ucilSource = 'nucleus_phone' }) {
  const deal = await hubspotFetch('/crm/v3/objects/deals', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        dealname: dealName,
        pipeline: 'default',
        dealstage: stage || 'appointmentscheduled',
        description: notes || '',
        ucil_source: ucilSource,
      },
    }),
  });

  if (contactId) {
    await hubspotFetch(
      `/crm/v3/objects/deals/${deal.id}/associations/contacts/${contactId}/deal_to_contact`,
      { method: 'PUT' }
    );
  }

  return deal;
}

/**
 * Fetch company properties by ID.
 */
async function getCompany(companyId) {
  const props = [
    // Firmographics
    'name', 'domain', 'industry', 'city', 'state', 'country',
    'numberofemployees', 'annualrevenue', 'description', 'phone', 'website',
    // Intelligence (populated for ~60 companies)
    'company_vernacular', 'ten_k_insights', 'ten_k_ticker', 'ten_k_filing_date',
    'leadership_ceo_strategy', 'capital_equipment_insights',
    'recent_ma_activity', 'sustainability_commitments',
    // Compliance
    'compliance_violation_type', 'compliance_violation_date',
    'compliance_violation_authority', 'environmental_compliance_budget',
    'compliance_overview',
    // Scoring
    'account_qualification_score', 'account_tier',
  ].join(',');
  return hubspotFetch(`/crm/v3/objects/companies/${companyId}?properties=${props}`);
}

module.exports = {
  // Exported for tests: the backoff SHAPE is the point of ju8, and a test that
  // hardcodes 500/8000 would keep passing after someone retunes them here.
  MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS, backoffMs,
  searchContacts, getContact, addNoteToContact,
  findContactByPhone, upsertContact, createDeal, getCompany,
};
