const { normalizePhone } = require('./phone');
const { throwHttpError } = require('./http-error');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 3;

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

async function hubspotFetch(path, options = {}, _retries = 0) {
  const url = `${HUBSPOT_BASE}${path}`;
  const method = options.method || 'GET';
  const resp = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });

  if (resp.status === 429) {
    if (_retries >= MAX_RETRIES) {
      // Structured error so callers can branch on err.status === 429 even
      // after the retry loop gave up.
      const text = await resp.text().catch(() => '');
      throwHttpError(resp, text, method, path, { service: 'HubSpot' });
    }
    const retryAfter = Math.max(1, parseInt(resp.headers.get('retry-after') || '2', 10));
    await new Promise(r => setTimeout(r, retryAfter * 1000));
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
  searchContacts, getContact, addNoteToContact,
  findContactByPhone, upsertContact, createDeal, getCompany,
  MAX_RETRIES,
};
