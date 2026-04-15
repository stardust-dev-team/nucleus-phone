/**
 * identity-resolver-hub.test.js — Covers the Phase 2c hub client:
 *   1. Successful hub call → adapter maps to ResolvedIdentity
 *   2. Cache hit returns without re-calling fetch
 *   3. Hub error falls back to inline resolver
 *   4. Config missing (no HUB_ADMIN_*) falls back to inline
 *   5. Adapter shape invariants
 */

jest.mock('../identity-resolver-inline', () => ({
  resolve: jest.fn(),
  toE164: (digits) => (digits ? (digits.length === 10 ? `+1${digits}` : `+${digits}`) : null),
}));

describe('identity-resolver hub client', () => {
  const realFetch = global.fetch;
  let resolver;
  let inline;

  beforeEach(() => {
    jest.resetModules();
    process.env.HUB_ADMIN_EMAIL = 'nucleus-phone@joruva.com';
    process.env.HUB_ADMIN_KEY = 'test-key';
    process.env.UCIL_HUB_URL = 'https://hub.test';
    delete process.env.USE_HUB_RESOLVER;
    // Re-require after resetModules so mock refs are fresh
    inline = require('../identity-resolver-inline');
    inline.resolve.mockReset();
    resolver = require('../identity-resolver');
    resolver.clearCache();
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.HUB_ADMIN_EMAIL;
    delete process.env.HUB_ADMIN_KEY;
    delete process.env.UCIL_HUB_URL;
    delete process.env.USE_HUB_RESOLVER;
    resolver && resolver.clearCache && resolver.clearCache();
  });

  function mockHubResponse(body, { ok = true, status = 200 } = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      ok, status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  const HUB_FOUND = {
    found: true,
    sources: ['hubspot', 'v35_pb_contacts'],
    contact: {
      id: 42, canonical_id: 'abc-123',
      first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe',
      email: 'jane@acme.com', phone: '+16305551234',
      title: 'VP Ops', linkedin_url: 'https://linkedin.com/in/janedoe',
      hubspot_contact_id: '12345', apollo_person_id: null,
    },
    company: {
      id: 7, canonical_id: 'co-abc', name: 'Acme Corp',
      domain: 'acme.com', hubspot_company_id: '99',
    },
    enrichments: {
      hubspot: { fit_score: '85', fit_reason: 'ICP match', persona: 'operator' },
      pb_contact: {
        summary: '20yr ops leader', industry: 'Manufacturing',
        duration_in_role: '3 years', profile_image: 'https://img/jane.jpg',
        past_experience: { company: 'OldCorp', title: 'Director' },
      },
      apollo: null, dropcontact_email: null,
    },
    interactions: [],
  };

  test('successful hub call → adapted ResolvedIdentity', async () => {
    mockHubResponse(HUB_FOUND);
    const id = await resolver.resolve('+16305551234');

    expect(id.resolved).toBe(true);
    expect(id.name).toBe('Jane Doe');
    expect(id.email).toBe('jane@acme.com');
    expect(id.company).toBe('Acme Corp');
    expect(id.hubspotContactId).toBe('12345');
    expect(id.hubspotCompanyId).toBe('99');
    expect(id.fitScore).toBe('85');
    expect(id.fitReason).toBe('ICP match');
    expect(id.persona).toBe('operator');
    expect(id.source).toBe('hubspot');
    expect(id.pbContactData.summary).toBe('20yr ops leader');
    expect(id.pbContactData.pastExperience.company).toBe('OldCorp');
    expect(id.profileImage).toBe('https://img/jane.jpg');
    expect(inline.resolve).not.toHaveBeenCalled();
  });

  test('cache hit returns without re-calling fetch', async () => {
    mockHubResponse(HUB_FOUND);
    await resolver.resolve('+16305551234');
    await resolver.resolve('+16305551234');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('cache key normalizes phone formatting', async () => {
    mockHubResponse(HUB_FOUND);
    await resolver.resolve('+16305551234');
    await resolver.resolve('(630) 555-1234');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('hub error falls back to inline', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    inline.resolve.mockResolvedValue({
      resolved: true, name: 'Fallback Name', source: 'hubspot',
      phone: '+16305551234', email: null, company: null,
      hubspotContactId: null, hubspotCompanyId: null,
      title: null, linkedinUrl: null, profileImage: null,
      pbContactData: null, fitScore: null, fitReason: null, persona: null,
    });

    const id = await resolver.resolve('+16305551234');
    expect(inline.resolve).toHaveBeenCalledWith('+16305551234');
    expect(id.name).toBe('Fallback Name');
  });

  test('hub 500 falls back to inline', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 500,
      text: async () => 'boom',
    });
    inline.resolve.mockResolvedValue({ resolved: false, source: 'unknown' });

    await resolver.resolve('+16305551234');
    expect(inline.resolve).toHaveBeenCalled();
  });

  test('USE_HUB_RESOLVER=false skips hub entirely', async () => {
    process.env.USE_HUB_RESOLVER = 'false';
    jest.resetModules();
    const newInline = require('../identity-resolver-inline');
    newInline.resolve.mockReset();
    newInline.resolve.mockResolvedValue({ resolved: false, source: 'unknown' });
    const r = require('../identity-resolver');
    r.clearCache();
    inline = newInline; // rebind so trailing assertion sees the right mock

    global.fetch = jest.fn();
    inline.resolve.mockResolvedValue({ resolved: false, source: 'unknown' });

    await r.resolve('+16305551234');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(inline.resolve).toHaveBeenCalled();
  });

  test('hub not-found → adapted unresolved identity', async () => {
    mockHubResponse({
      found: false, sources: [],
      contact: { id: null, phone: '+16305551234', name: null, email: null,
        first_name: null, last_name: null, title: null, linkedin_url: null,
        hubspot_contact_id: null, apollo_person_id: null, canonical_id: null },
      company: null,
      enrichments: { hubspot: null, pb_contact: null, apollo: null, dropcontact_email: null },
      interactions: [],
    });
    const id = await resolver.resolve('+16305551234');
    expect(id.resolved).toBe(false);
    expect(id.source).toBe('unknown');
    expect(id.phone).toBe('+16305551234');
  });

  test('adapter: multi-source picks highest priority', () => {
    const adapted = resolver._adapt({
      found: true,
      sources: ['v35_pb_contacts', 'apollo', 'hubspot'],
      contact: { name: 'X', phone: null, email: null, hubspot_contact_id: '1',
        canonical_id: null, id: 1, first_name: 'X', last_name: null,
        title: null, linkedin_url: null, apollo_person_id: null },
      company: null,
      enrichments: { hubspot: { fit_score: 90 }, pb_contact: null, apollo: null,
        dropcontact_email: null },
      interactions: [],
    }, 'x@y.com');
    expect(adapted.source).toBe('hubspot');
  });

  test('adapter: dropcontact-only source when only email via DC', () => {
    const adapted = resolver._adapt({
      found: true,
      sources: ['dropcontact'],
      contact: { name: 'X', phone: '+16305551234', email: 'x@y.com',
        hubspot_contact_id: null, canonical_id: null, id: null,
        first_name: 'X', last_name: null, title: null, linkedin_url: null,
        apollo_person_id: null },
      company: null,
      enrichments: { hubspot: null, pb_contact: null, apollo: null,
        dropcontact_email: 'x@y.com' },
      interactions: [],
    }, '+16305551234');
    expect(adapted.source).toBe('dropcontact');
    expect(adapted.email).toBe('x@y.com');
  });

  test('missing HUB_ADMIN_* falls back to inline', async () => {
    delete process.env.HUB_ADMIN_EMAIL;
    delete process.env.HUB_ADMIN_KEY;
    jest.resetModules();
    const newInline = require('../identity-resolver-inline');
    newInline.resolve.mockReset();
    newInline.resolve.mockResolvedValue({ resolved: false, source: 'unknown' });
    const r = require('../identity-resolver');
    r.clearCache();
    inline = newInline; // rebind so trailing assertion sees the right mock
    global.fetch = jest.fn();
    inline.resolve.mockResolvedValue({ resolved: false, source: 'unknown' });

    await r.resolve('+16305551234');
    expect(inline.resolve).toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
