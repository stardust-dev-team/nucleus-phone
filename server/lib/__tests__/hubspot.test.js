const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');

let searchContacts, getContact, findContactByPhone, upsertContact, createDeal, getCompany, MAX_RETRIES;

beforeEach(() => {
  installFetchMock();
  process.env.HUBSPOT_ACCESS_TOKEN = 'test-token';
  jest.isolateModules(() => {
    ({ searchContacts, getContact, findContactByPhone, upsertContact, createDeal, getCompany, MAX_RETRIES }
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

describe('hubspotFetch — 429 rate-limit retry', () => {
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

  // TODO(nucleus-phone-ju8): 5xx are transient (LB bounce, pod restart) and
  // should retry with jitter+cap, same as 429. This test pins current behavior;
  // remove/flip when the retry policy is extended.
  test('5xx does NOT retry — throws immediately (only 429 retries)', async () => {
    mockFetchResponse('internal error', { status: 503 });
    let caught;
    try { await searchContacts('acme'); } catch (e) { caught = e; }
    expect(caught.status).toBe(503);
    expect(caught.method).toBe('POST');
    expect(caught.endpoint).toBe('/crm/v3/objects/contacts/search');
    expect(caught.body).toContain('internal error');
    expect(caught.message).toMatch(/HubSpot POST \/crm\/v3\/objects\/contacts\/search \(503\)/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
