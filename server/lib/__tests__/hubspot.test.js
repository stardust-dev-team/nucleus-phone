const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');

let searchContacts, getContact, findContactByPhone, upsertContact, createDeal, getCompany, MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS, backoffMs;

beforeEach(() => {
  installFetchMock();
  process.env.HUBSPOT_ACCESS_TOKEN = 'test-token';
  jest.isolateModules(() => {
    ({ searchContacts, getContact, findContactByPhone, upsertContact, createDeal, getCompany, MAX_RETRIES, RETRY_BASE_MS, RETRY_CAP_MS, backoffMs }
      = require('../hubspot'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  jest.restoreAllMocks();
});

describe('hubspotFetch (via searchContacts)', () => {
  test('sends Bearer auth + JSON content-type, POSTs to correct URL', async () => {
    mockFetchResponse({ results: [], total: 0 });
    await searchContacts('acme', 25);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/search');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.query).toBe('acme');
    expect(body.limit).toBe(25);
  });

  test('returns parsed JSON on success', async () => {
    mockFetchResponse({ results: [{ id: 'c1' }], total: 1 });
    const result = await searchContacts('acme');
    expect(result).toEqual({ results: [{ id: 'c1' }], total: 1 });
  });

  test('throws structured error (status/body/endpoint/method) on non-2xx', async () => {
    mockFetchResponse('{"status":"error","message":"bad token"}', { status: 401 });
    let caught;
    try { await searchContacts('acme'); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(401);
    expect(caught.body).toContain('bad token');
    expect(caught.endpoint).toBe('/crm/v3/objects/contacts/search');
    expect(caught.method).toBe('POST');
    expect(caught.message).toMatch(/HubSpot POST \/crm\/v3\/objects\/contacts\/search \(401\)/);
  });

  test('GET returns correct method on structured error', async () => {
    mockFetchResponse('not found', { status: 404 });
    let caught;
    try { await getContact('xyz'); } catch (e) { caught = e; }
    expect(caught.status).toBe(404);
    expect(caught.method).toBe('GET');
    expect(caught.endpoint).toMatch(/\/crm\/v3\/objects\/contacts\/xyz/);
  });

  test('returns null for 204 No Content', async () => {
    mockFetchResponse('', { status: 204 });
    const result = await getContact('c1');
    expect(result).toBeNull();
  });
});

describe('hubspotFetch — retry policy (429 + 5xx)', () => {
  test('retries after retry-after header then succeeds', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('rate limited', { status: 429, headers: { 'retry-after': '1' } });
    mockFetchResponse({ results: [{ id: 'c1' }], total: 1 });

    const result = await searchContacts('acme');
    expect(result.total).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('honors retry-after value (passed to setTimeout as ms)', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('rate limited', { status: 429, headers: { 'retry-after': '5' } });
    mockFetchResponse({ results: [], total: 0 });

    await searchContacts('acme');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  test('defaults retry-after to 2 seconds when header missing', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('rate limited', { status: 429 });
    mockFetchResponse({ results: [], total: 0 });

    await searchContacts('acme');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
  });

  test('throws structured error with status=429 after MAX_RETRIES exhausted', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    const totalCalls = MAX_RETRIES + 1; // initial + MAX_RETRIES retries
    for (let i = 0; i < totalCalls; i++) {
      mockFetchResponse('slow down', { status: 429, headers: { 'retry-after': '1' } });
    }

    let caught;
    try { await searchContacts('acme'); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(429);
    expect(caught.endpoint).toBe('/crm/v3/objects/contacts/search');
    expect(caught.method).toBe('POST');
    expect(caught.message).toMatch(/HubSpot POST \/crm\/v3\/objects\/contacts\/search \(429\)/);
    expect(global.fetch).toHaveBeenCalledTimes(totalCalls);
  });

  // nucleus-phone-ju8: 5xx are transient (LB bounce, pod restart, Cloudflare hiccup)
  // and now retry with jittered backoff, capped at MAX_RETRIES — same resilience as 429.
  test('5xx retries with backoff then succeeds (transient)', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('bad gateway', { status: 502 }); // first attempt fails
    mockFetchResponse({ results: [], total: 0 });       // retry succeeds
    const result = await searchContacts('acme');
    expect(result).toEqual({ results: [], total: 0 });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('5xx backoff is FULL-JITTER and CAPPED — the exact delays, not just "some delay"', async () => {
    // The inherited tests proved 5xx retries HAPPEN and said nothing about the
    // delay's shape, so mutation testing showed both the cap and the jitter
    // could be deleted with a green suite — and those are the whole point.
    // Pin the arithmetic with a deterministic Math.random. backoffMs(n) =
    // floor(random * min(CAP, BASE * 2^n)) with BASE=500, CAP=8000, so at
    // random=0.5 the three retries are 250 / 500 / 1000.
    //   - drop the jitter (return expo) -> 500 / 1000 / 2000, red here
    //   - drop the cap  (min -> max)    -> 4000 / 4000 / 4000, red here
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    for (let i = 0; i < MAX_RETRIES + 1; i++) mockFetchResponse('bad gateway', { status: 502 });

    try { await searchContacts('acme'); } catch { /* exhaustion is asserted elsewhere */ }

    const delays = setTimeoutSpy.mock.calls.map(([, ms]) => ms);
    expect(delays).toEqual([250, 500, 1000]);
  });

  test('the cap is currently UNREACHABLE at MAX_RETRIES=3 — tripwire, not coverage', () => {
    // The test above does NOT exercise clamping: the exponential peaks at
    // 2000ms, under the 8000ms cap. When this fails, the cap has gone live and
    // that test needs a case where min() actually clamps.
    expect(RETRY_BASE_MS * 2 ** (MAX_RETRIES - 1)).toBeLessThan(RETRY_CAP_MS);
  });

  test('HTTP 500 itself retries — pins the >= 500 threshold', async () => {
    // The other 5xx tests use 502/503, so `>= 500` -> `>= 501` survived
    // mutation. 500 is also the commonest generic upstream error.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('boom', { status: 500 });
    mockFetchResponse({ results: [], total: 0 });
    await searchContacts('acme');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('backoffMs directly: full jitter within [0, min(cap, base*2^n))', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(backoffMs(0)).toBe(499);    // floor(0.999 * 500)
    expect(backoffMs(1)).toBe(999);
    Math.random.mockReturnValue(0);
    expect(backoffMs(0)).toBe(0);      // full jitter may fire immediately
    Math.random.mockReturnValue(0.5);
    expect(backoffMs(10)).toBe(4000);  // clamped by the 8000ms cap
  });

  /* ── the dangerous half: 5xx must NOT retry a non-idempotent create ── */

  test('SECURITY-OF-DATA: POST /deals does NOT retry on 5xx — a 504 may mean the deal was created', async () => {
    // HubSpot's CRM v3 object API has no idempotency key. A 504 usually means
    // the gateway gave up while the write LANDED, so retrying double-creates.
    // The blanket `>= 500` retry this change started as would have armed that
    // for whoever wires createDeal up (it has no in-tree caller yet).
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('gateway timeout', { status: 504 });

    let caught;
    try { await createDeal({ name: 'Acme', amount: 1000 }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(504);
    expect(global.fetch).toHaveBeenCalledTimes(1);   // exactly one attempt
  });

  test('the read-only /search POST DOES retry — it opts in with idempotent:true', async () => {
    // Proves the guard discriminates by intent rather than blanket-blocking
    // POST, and that `idempotent` is honoured.
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('bad gateway', { status: 502 });
    mockFetchResponse({ results: [], total: 0 });
    await searchContacts('acme');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('`idempotent` never reaches fetch() as a request option', async () => {
    // It is destructured out of init; leaking it would put a junk key on the
    // wire and could confuse undici.
    mockFetchResponse({ results: [], total: 0 });
    await searchContacts('acme');
    expect(global.fetch.mock.calls[0][1]).not.toHaveProperty('idempotent');
  });

  test('a 5xx Retry-After is honoured when it exceeds our own backoff', async () => {
    // Our backoff peaks at 2s. If HubSpot says 30s during a real outage,
    // hammering burns the whole budget in under two seconds.
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    mockFetchResponse('unavailable', { status: 503, headers: { 'retry-after': '30' } });
    mockFetchResponse({ results: [], total: 0 });
    await searchContacts('acme');
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
  });

  test('5xx throws structured error after MAX_RETRIES exhausted', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
    const totalCalls = MAX_RETRIES + 1; // initial + MAX_RETRIES retries
    for (let i = 0; i < totalCalls; i++) {
      mockFetchResponse('internal error', { status: 503 });
    }
    let caught;
    try { await searchContacts('acme'); } catch (e) { caught = e; }
    expect(caught.status).toBe(503);
    expect(caught.method).toBe('POST');
    expect(caught.endpoint).toBe('/crm/v3/objects/contacts/search');
    expect(caught.body).toContain('internal error');
    expect(caught.message).toMatch(/HubSpot POST \/crm\/v3\/objects\/contacts\/search \(503\)/);
    expect(global.fetch).toHaveBeenCalledTimes(totalCalls);
  });

  test('4xx (non-429) still throws immediately — no retry', async () => {
    mockFetchResponse('bad request', { status: 400 });
    let caught;
    try { await searchContacts('acme'); } catch (e) { caught = e; }
    expect(caught.status).toBe(400);
    expect(global.fetch).toHaveBeenCalledTimes(1); // client error — not retried
  });
});

describe('findContactByPhone', () => {
  test('returns null when phone is invalid/unnormalizable', async () => {
    const result = await findContactByPhone('not-a-phone');
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('stops at first filter that returns a match (EQ on phone)', async () => {
    mockFetchResponse({ total: 1, results: [{ id: 'c1', properties: { phone: '+16025551234' } }] });
    const result = await findContactByPhone('+16025551234');
    expect(result.id).toBe('c1');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('falls through EQ→CONTAINS_TOKEN filters when earlier attempts find nothing', async () => {
    mockFetchResponse({ total: 0, results: [] }); // phone EQ
    mockFetchResponse({ total: 0, results: [] }); // mobilephone EQ
    mockFetchResponse({ total: 0, results: [] }); // phone CONTAINS_TOKEN
    mockFetchResponse({ total: 1, results: [{ id: 'c9' }] }); // mobilephone CONTAINS_TOKEN

    const result = await findContactByPhone('+16025551234');
    expect(result.id).toBe('c9');
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });
});

describe('createDeal', () => {
  test('creates deal and associates contact when contactId provided', async () => {
    mockFetchResponse({ id: 'd1', properties: {} });
    mockFetchResponse({}); // PUT association

    const deal = await createDeal({ contactId: 'c1', dealName: 'Test', stage: 'qualified' });
    expect(deal.id).toBe('d1');
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const [, assocOpts] = global.fetch.mock.calls[1];
    expect(assocOpts.method).toBe('PUT');
    const [assocUrl] = global.fetch.mock.calls[1];
    expect(assocUrl).toMatch(/\/deals\/d1\/associations\/contacts\/c1\/deal_to_contact$/);
  });

  test('skips association call when contactId is falsy', async () => {
    mockFetchResponse({ id: 'd2' });
    await createDeal({ contactId: null, dealName: 'Lone' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
