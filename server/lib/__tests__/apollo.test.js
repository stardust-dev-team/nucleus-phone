const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let matchPerson, revealPerson, searchPeopleByCompany;

beforeEach(() => {
  installFetchMock();
  process.env.APOLLO_API_KEY = 'test-key';
  jest.isolateModules(() => {
    ({ matchPerson, revealPerson, searchPeopleByCompany } = require('../apollo'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.APOLLO_API_KEY;
});

describe('matchPerson', () => {
  test('POSTs to people/match with X-Api-Key header + name/org body', async () => {
    mockFetchResponse({ person: { id: 'p1', name: 'Jane Doe' } });
    const result = await matchPerson({ firstName: 'Jane', lastName: 'Doe', organization: 'Acme' });
    expect(result).toEqual({ id: 'p1', name: 'Jane Doe' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.apollo.io/api/v1/people/match');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-Api-Key']).toBe('test-key');
    expect(JSON.parse(opts.body)).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      organization_name: 'Acme',
    });
  });

  test('includes email when provided', async () => {
    mockFetchResponse({ person: { id: 'p1' } });
    await matchPerson({ firstName: 'J', lastName: 'D', organization: 'A', email: 'j@a.com' });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).email).toBe('j@a.com');
  });

  test('returns null on missing person in response', async () => {
    mockFetchResponse({});
    expect(await matchPerson({ firstName: 'J', lastName: 'D', organization: 'A' })).toBeNull();
  });

  test('returns null (soft-fail) when APOLLO_API_KEY is not set — Apollo is optional enrichment', async () => {
    // Unlike Vapi (hard-fail), Apollo is enrichment — missing key shouldn't break the pipeline.
    delete process.env.APOLLO_API_KEY;
    expect(await matchPerson({ firstName: 'J', lastName: 'D', organization: 'A' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('throws structured error (status/body/endpoint/method) on non-2xx', async () => {
    mockFetchResponse('{"error":"rate limited"}', { status: 429 });
    let caught;
    try { await matchPerson({ firstName: 'J', lastName: 'D', organization: 'A' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);
    expect(caught.body).toContain('rate limited');
    expect(caught.endpoint).toBe('people/match');
    expect(caught.method).toBe('POST');
    expect(caught.message).toMatch(/Apollo POST people\/match \(429\)/);
  });
});

describe('revealPerson', () => {
  test('POSTs id + webhook_url when requestPhone=true (default)', async () => {
    mockFetchResponse({ person: { id: 'p1', name: 'Jane', phone_numbers: [] } });
    await revealPerson('p1');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.id).toBe('p1');
    expect(body.reveal_phone_number).toBe(true);
    expect(body.webhook_url).toMatch(/apollo\/phone-webhook/);
  });

  test('omits phone fields when requestPhone=false', async () => {
    mockFetchResponse({ person: { id: 'p1', name: 'Jane' } });
    await revealPerson('p1', false);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.reveal_phone_number).toBeUndefined();
    expect(body.webhook_url).toBeUndefined();
  });

  test('extracts mobile phone from phone_numbers array', async () => {
    mockFetchResponse({
      person: {
        id: 'p1', first_name: 'Jane', last_name: 'Doe', title: 'VP',
        phone_numbers: [
          { type_cd: 'work', sanitized_number: '+15555550001' },
          { type_cd: 'mobile', sanitized_number: '+16025551234' },
        ],
      },
    });
    const r = await revealPerson('p1');
    expect(r.phone).toBe('+16025551234');
    expect(r.apollo_person_id).toBe('p1');
  });

  test('throws structured error on non-2xx', async () => {
    mockFetchResponse('{"error":"gone"}', { status: 500 });
    let caught;
    try { await revealPerson('p1'); } catch (e) { caught = e; }
    expect(caught.status).toBe(500);
    expect(caught.endpoint).toBe('people/match');
    expect(caught.method).toBe('POST');
  });

  test('returns null soft-fail on missing API key', async () => {
    delete process.env.APOLLO_API_KEY;
    expect(await revealPerson('p1')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('searchPeopleByCompany', () => {
  function mockOrgThenSearch({ org, previews }) {
    mockFetchResponse({ organizations: org ? [org] : [] });
    mockFetchResponse({ people: previews });
  }

  test('returns empty (with failures:[]) when org not found', async () => {
    mockOrgThenSearch({ org: null, previews: [] });
    const result = await searchPeopleByCompany('acme.com');
    expect(result).toEqual({ previews: [], contacts: [], creditsUsed: 0, failures: [] });
  });

  test('rejects org with mismatched primary_domain', async () => {
    mockFetchResponse({ organizations: [{ id: 'o1', primary_domain: 'other.com' }] });
    const result = await searchPeopleByCompany('acme.com');
    expect(result).toEqual({ previews: [], contacts: [], creditsUsed: 0, failures: [] });
  });

  test('throws structured error on org-search failure (not swallowed)', async () => {
    mockFetchResponse('{"error":"auth"}', { status: 401 });
    let caught;
    try { await searchPeopleByCompany('acme.com'); } catch (e) { caught = e; }
    expect(caught.status).toBe(401);
    expect(caught.endpoint).toBe('organizations/search');
  });

  test('throws structured error on people-search failure (not swallowed)', async () => {
    mockFetchResponse({ organizations: [{ id: 'o1', primary_domain: 'acme.com' }] });
    mockFetchResponse('{"error":"quota"}', { status: 429 });
    let caught;
    try { await searchPeopleByCompany('acme.com'); } catch (e) { caught = e; }
    expect(caught.status).toBe(429);
    expect(caught.endpoint).toBe('mixed_people/api_search');
  });

  test('only reveals previews with has_direct_phone=Yes when requestPhone=true', async () => {
    mockOrgThenSearch({
      org: { id: 'o1', primary_domain: 'acme.com' },
      previews: [
        { id: 'p1', has_direct_phone: 'Yes' },
        { id: 'p2', has_direct_phone: 'No' },
      ],
    });
    // reveal call for p1 only
    mockFetchResponse({ person: { id: 'p1', first_name: 'Jane', phone_numbers: [{ type_cd: 'mobile', sanitized_number: '+15555551111' }] } });

    const result = await searchPeopleByCompany('acme.com');
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].apollo_person_id).toBe('p1');
    expect(result.creditsUsed).toBe(8); // PHONE_REVEAL_CREDIT_COST
    expect(result.failures).toEqual([]);
  });

  test('uses 1-credit cost when requestPhone=false and reveals ALL previews', async () => {
    mockOrgThenSearch({
      org: { id: 'o1', primary_domain: 'acme.com' },
      previews: [
        { id: 'p1', has_direct_phone: 'No' },
        { id: 'p2', has_direct_phone: 'No' },
      ],
    });
    mockFetchResponse({ person: { id: 'p1', first_name: 'A' } });
    mockFetchResponse({ person: { id: 'p2', first_name: 'B' } });

    const result = await searchPeopleByCompany('acme.com', { requestPhone: false });
    expect(result.contacts).toHaveLength(2);
    expect(result.creditsUsed).toBe(2);
  });

  test('COLLECT-AND-RETURN: partial reveal failure — success + structured failure, NOT thrown', async () => {
    // The whole point of option C. One 500 on a reveal must not abort the whole search,
    // AND must not be silently swallowed — caller gets structured failure metadata.
    mockOrgThenSearch({
      org: { id: 'o1', primary_domain: 'acme.com' },
      previews: [
        { id: 'p1', has_direct_phone: 'Yes' },
        { id: 'p2', has_direct_phone: 'Yes' },
      ],
    });
    mockFetchResponse({ person: { id: 'p1', first_name: 'Jane', phone_numbers: [{ type_cd: 'mobile', sanitized_number: '+15555551111' }] } });
    mockFetchResponse('{"error":"internal"}', { status: 500 });

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await searchPeopleByCompany('acme.com');
      expect(result.contacts).toHaveLength(1);
      expect(result.contacts[0].apollo_person_id).toBe('p1');
      expect(result.creditsUsed).toBe(8); // only the successful reveal
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatchObject({
        id: 'p2',
        status: 500,
        endpoint: 'people/match',
      });
      expect(result.failures[0].body).toContain('internal');
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/p2.*500/));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('COLLECT-AND-RETURN: network error on reveal gets failure entry with status=undefined', async () => {
    // Network errors have no err.status. Callers must be able to distinguish
    // "Apollo returned 500" from "couldn't reach Apollo" — status:undefined is that signal.
    mockOrgThenSearch({
      org: { id: 'o1', primary_domain: 'acme.com' },
      previews: [{ id: 'p1', has_direct_phone: 'Yes' }],
    });
    mockFetchError(new Error('ECONNRESET'));

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await searchPeopleByCompany('acme.com');
      expect(result.contacts).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].id).toBe('p1');
      expect(result.failures[0].status).toBeUndefined();
      expect(result.failures[0].message).toMatch(/ECONNRESET/);
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/status n\/a/));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('returns empty (with failures:[]) on missing API key — soft-fail', async () => {
    delete process.env.APOLLO_API_KEY;
    const result = await searchPeopleByCompany('acme.com');
    expect(result).toEqual({ previews: [], contacts: [], creditsUsed: 0, failures: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
