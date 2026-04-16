const { installFetchMock, mockFetchResponse } = require('../../__tests__/helpers/mock-fetch');

let reverseSearch;

beforeEach(() => {
  installFetchMock();
  process.env.DROPCONTACT_API_KEY = 'test-token';
  // Dropcontact polls every 3s with a 60s deadline. Mock setTimeout so tests
  // don't actually wait. Real Date.now() advances in microseconds, well under
  // the 60s deadline, so the loop exits only when success OR when the mock
  // fetch queue is exhausted.
  jest.spyOn(global, 'setTimeout').mockImplementation(fn => { fn(); return 0; });
  jest.isolateModules(() => {
    ({ reverseSearch } = require('../dropcontact'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.DROPCONTACT_API_KEY;
  jest.restoreAllMocks();
});

describe('reverseSearch — submit', () => {
  test('POSTs to /batch with X-Access-Token + phone/name/company payload', async () => {
    mockFetchResponse({ request_id: 'req-1' });
    mockFetchResponse({ success: true, data: [{ email: [{ email: 'j@a.com', qualification: 'ok' }] }] });

    const result = await reverseSearch({ phone: '+16025551234', firstName: 'Jane', lastName: 'Doe', company: 'Acme' });
    expect(result).toEqual({ email: 'j@a.com', qualification: 'ok' });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.dropcontact.io/batch');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-Access-Token']).toBe('test-token');
    expect(opts.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(opts.body);
    expect(body.data).toEqual([{ phone: '+16025551234', first_name: 'Jane', last_name: 'Doe', company: 'Acme' }]);
    expect(body.siren).toBe(false);
    expect(body.language).toBe('en');
  });

  test('omits optional fields (first_name/last_name/company) when not provided', async () => {
    mockFetchResponse({ request_id: 'req-1' });
    mockFetchResponse({ success: true, data: [{ email: [{ email: 'j@a.com', qualification: 'ok' }] }] });

    await reverseSearch({ phone: '+16025551234' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.data[0]).toEqual({ phone: '+16025551234' });
  });

  test('returns null soft-fail when DROPCONTACT_API_KEY missing', async () => {
    delete process.env.DROPCONTACT_API_KEY;
    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result).toEqual({ email: null, qualification: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('throws structured error (status/body/endpoint/method) on submit non-2xx', async () => {
    mockFetchResponse('{"error":"bad request"}', { status: 400 });
    let caught;
    try { await reverseSearch({ phone: '+16025551234' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(400);
    expect(caught.body).toContain('bad request');
    expect(caught.endpoint).toBe('batch');
    expect(caught.method).toBe('POST');
    expect(caught.message).toMatch(/Dropcontact POST batch \(400\)/);
  });

  test('throws plain Error when submit succeeds but no request_id returned', async () => {
    mockFetchResponse({ /* no request_id */ });
    let caught;
    try { await reverseSearch({ phone: '+16025551234' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/no request_id/);
  });
});

describe('reverseSearch — poll', () => {
  test('extracts email from first element of contact.email array', async () => {
    mockFetchResponse({ request_id: 'req-2' });
    mockFetchResponse({
      success: true,
      data: [{
        email: [
          { email: 'primary@a.com', qualification: 'nominative' },
          { email: 'secondary@a.com', qualification: 'uncertain' },
        ],
      }],
    });
    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result).toEqual({ email: 'primary@a.com', qualification: 'nominative' });
  });

  test('returns {null, null} when contact exists but has no email', async () => {
    mockFetchResponse({ request_id: 'req-3' });
    mockFetchResponse({ success: true, data: [{ /* no email field */ }] });
    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result).toEqual({ email: null, qualification: null });
  });

  test('returns {null, null} when data array is empty', async () => {
    mockFetchResponse({ request_id: 'req-3' });
    mockFetchResponse({ success: true, data: [] });
    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result).toEqual({ email: null, qualification: null });
  });

  test('polls GET /batch/:id with X-Access-Token', async () => {
    mockFetchResponse({ request_id: 'req-poll' });
    mockFetchResponse({ success: true, data: [{ email: [{ email: 'j@a.com', qualification: 'ok' }] }] });

    await reverseSearch({ phone: '+16025551234' });
    const [pollUrl, pollOpts] = global.fetch.mock.calls[1];
    expect(pollUrl).toBe('https://api.dropcontact.io/batch/req-poll');
    expect(pollOpts.headers['X-Access-Token']).toBe('test-token');
    expect(pollOpts.method).toBeUndefined(); // GET default
  });

  test('retries poll on !success (batch still processing) until success', async () => {
    mockFetchResponse({ request_id: 'req-4' });
    mockFetchResponse({ success: false }); // still processing
    mockFetchResponse({ success: false }); // still processing
    mockFetchResponse({ success: true, data: [{ email: [{ email: 'j@a.com', qualification: 'ok' }] }] });

    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result.email).toBe('j@a.com');
    expect(global.fetch).toHaveBeenCalledTimes(4); // 1 submit + 3 polls
  });

  test('retries poll on transient 5xx (not fatal) and logs warning', async () => {
    mockFetchResponse({ request_id: 'req-5' });
    mockFetchResponse('internal', { status: 503 }); // retriable
    mockFetchResponse('rate limited', { status: 429 }); // retriable
    mockFetchResponse({ success: true, data: [{ email: [{ email: 'j@a.com', qualification: 'ok' }] }] });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result.email).toBe('j@a.com');
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Dropcontact poll transient 503 for req-5/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Dropcontact poll transient 429 for req-5/));
    warnSpy.mockRestore();
  });

  test('throws structured error on fatal 401 during poll (endpoint includes request_id)', async () => {
    mockFetchResponse({ request_id: 'req-6' });
    mockFetchResponse('{"error":"unauthorized"}', { status: 401 });

    let caught;
    try { await reverseSearch({ phone: '+16025551234' }); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(401);
    expect(caught.body).toContain('unauthorized');
    expect(caught.endpoint).toBe('batch/req-6');
    expect(caught.method).toBe('GET');
    expect(caught.message).toMatch(/Dropcontact GET batch\/req-6 \(401\)/);
  });

  test('returns {null, null} when deadline exceeded (batch never completes)', async () => {
    mockFetchResponse({ request_id: 'req-timeout' });

    // Simulate time advancing past the 60s deadline on each poll attempt.
    // First call is Date.now() for the deadline; subsequent calls exceed it
    // after a few iterations.
    let nowCallCount = 0;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount++;
      // First call: sets deadline to base + 60000
      // After 3 poll attempts, exceed the deadline
      return realNow() + (nowCallCount > 3 ? 120000 : 0);
    });

    // Queue enough "not ready" responses to fill the loop
    for (let i = 0; i < 5; i++) {
      mockFetchResponse({ success: false });
    }

    const result = await reverseSearch({ phone: '+16025551234' });
    expect(result).toEqual({ email: null, qualification: null });
    // Date.now() called: once for deadline, once per while-check.
    // Call 1 (deadline): nowCallCount=1, returns base. Call 2 (check): count=2, base. True → poll.
    // Call 3 (check): count=3, base. True → poll. Call 4 (check): count=4 > 3, returns base+120s. False → exit.
    // Result: 1 submit + 2 polls = 3 fetch calls.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test.each([403, 404])('throws structured error on fatal %i during poll', async (status) => {
    mockFetchResponse({ request_id: 'req-7' });
    mockFetchResponse('fatal', { status });

    let caught;
    try { await reverseSearch({ phone: '+16025551234' }); } catch (e) { caught = e; }
    expect(caught.status).toBe(status);
    expect(caught.endpoint).toBe('batch/req-7');
    expect(caught.method).toBe('GET');
  });
});
