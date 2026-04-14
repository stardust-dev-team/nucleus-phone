const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let createOutboundCall, stopCall, getCall, stopCallAndLog;

beforeEach(() => {
  installFetchMock();
  process.env.VAPI_API_KEY = 'test-key';
  process.env.VAPI_PRACTICE_PHONE_ID = 'phone-123';
  jest.isolateModules(() => {
    ({ createOutboundCall, stopCall, getCall, stopCallAndLog } = require('../vapi'));
  });
});

afterEach(() => {
  delete global.fetch;
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PRACTICE_PHONE_ID;
});

describe('createOutboundCall', () => {
  test('POSTs to call/phone with assistant + customer + phoneNumberId', async () => {
    mockFetchResponse({ id: 'call-abc' });
    const result = await createOutboundCall({
      assistantId: 'asst-1',
      customerNumber: '+16025551234',
    });
    expect(result).toEqual({ id: 'call-abc' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.vapi.ai/call/phone');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(opts.body)).toEqual({
      assistantId: 'asst-1',
      customer: { number: '+16025551234' },
      phoneNumberId: 'phone-123',
    });
  });

  test('passes assistantOverrides when provided', async () => {
    mockFetchResponse({ id: 'call-abc' });
    await createOutboundCall({
      assistantId: 'asst-1',
      customerNumber: '+16025551234',
      assistantOverrides: { firstMessage: 'Hi Tom' },
    });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.assistantOverrides).toEqual({ firstMessage: 'Hi Tom' });
  });
});

describe('stopCall', () => {
  test('uses DELETE /call/{id} — NOT POST /call/{id}/stop (Vapi 404 regression)', async () => {
    mockFetchResponse('', { status: 204 });
    await stopCall('019d8a63-eb3c-7eed-951a-e93883cc140f');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    expect(url).toBe('https://api.vapi.ai/call/019d8a63-eb3c-7eed-951a-e93883cc140f');
    // Anti-regression: the old broken path must never come back.
    expect(url).not.toMatch(/\/stop$/);
  });

  test('returns {} on 204 via status short-circuit (does NOT call res.json())', async () => {
    // Prove the 204 branch actually fires — if it fell through to res.json(),
    // this mock would throw. Two-bugs-masking-each-other protection.
    const fetchMock = global.fetch;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => { throw new Error('res.json() should not be called on 204'); },
      text: async () => '',
    });
    const result = await stopCall('call-id');
    expect(result).toEqual({});
  });

  test('returns {} on content-length: 0 via header short-circuit', async () => {
    mockFetchResponse('', { status: 200, headers: { 'content-length': '0' } });
    // If this ever calls res.json() it will parse '' and throw — same protection as above.
    const result = await stopCall('call-id');
    expect(result).toEqual({});
  });

  test('throws structured error with status + body on non-2xx', async () => {
    mockFetchResponse('{"message":"Call not found"}', { status: 404 });
    let caught;
    try { await stopCall('missing-id'); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.status).toBe(404);
    expect(caught.body).toContain('Call not found');
    expect(caught.endpoint).toBe('call/missing-id');
    expect(caught.method).toBe('DELETE');
    expect(caught.message).toMatch(/Vapi DELETE call\/missing-id \(404\)/);
  });

  test('rejects empty/invalid call IDs', async () => {
    await expect(stopCall('')).rejects.toThrow(/valid call ID/);
    await expect(stopCall(null)).rejects.toThrow(/valid call ID/);
    await expect(stopCall(123)).rejects.toThrow(/valid call ID/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('propagates network errors WITHOUT err.status (distinguishable from API failures)', async () => {
    mockFetchError(new Error('ECONNRESET'));
    let caught;
    try { await stopCall('call-id'); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/ECONNRESET/);
    // Network errors must NOT have err.status — callers that branch on
    // err.status === 404 must treat network failures as "other", not "already gone".
    expect(caught.status).toBeUndefined();
  });
});

describe('getCall', () => {
  test('GETs call/{id} and returns JSON', async () => {
    mockFetchResponse({ id: 'call-abc', status: 'ended', transcript: 'Hi' });
    const result = await getCall('call-abc');
    expect(result.transcript).toBe('Hi');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('GET');
    expect(url).toBe('https://api.vapi.ai/call/call-abc');
    expect(opts.body).toBeUndefined();
  });

  test('rejects empty call ID', async () => {
    await expect(getCall('')).rejects.toThrow(/valid call ID/);
  });
});

describe('auth (shared vapiRequest gate)', () => {
  test.each([
    ['stopCall', () => stopCall('call-id')],
    ['getCall', () => getCall('call-id')],
    ['createOutboundCall', () => createOutboundCall({ assistantId: 'a', customerNumber: '+1' })],
  ])('%s throws if VAPI_API_KEY is not set', async (_name, fn) => {
    delete process.env.VAPI_API_KEY;
    await expect(fn()).rejects.toThrow(/VAPI_API_KEY not set/);
  });
});

describe('stopCallAndLog (branching logic extracted for testability)', () => {
  test('returns "stopped" on success', async () => {
    mockFetchResponse('', { status: 204 });
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await stopCallAndLog('call-abc', logger);
    expect(result).toBe('stopped');
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('returns "already-ended" on 404 — logs at .log, NOT .error', async () => {
    // This is the whole point of the refactor. A 404 at End Call means
    // Vapi already ended the call (inactivity timeout). It's not an error.
    mockFetchResponse('{"message":"Call not found"}', { status: 404 });
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await stopCallAndLog('call-abc', logger);
    expect(result).toBe('already-ended');
    expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/already ended \(404\)/));
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('returns "failed" on 500 — logs LOUDLY at .error', async () => {
    // The old code logged every failure at console.warn with a misleading
    // "may have already ended" — that lie is how the Vapi bug hid for weeks.
    mockFetchResponse('{"error":"Internal"}', { status: 500 });
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await stopCallAndLog('call-abc', logger);
    expect(result).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Vapi stop FAILED for call-abc \(status 500\)/),
      expect.any(String),
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('returns "failed" on network error (no err.status) — logs at .error', async () => {
    // Network errors have no status. They must NOT be mistaken for "already ended".
    mockFetchError(new Error('ECONNRESET'));
    const logger = { log: jest.fn(), error: jest.fn() };
    const result = await stopCallAndLog('call-abc', logger);
    expect(result).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/status n\/a/),
      expect.any(String),
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  test('defaults to console when no logger passed', async () => {
    // Smoke test — production callers pass no logger. Must not throw.
    mockFetchResponse('', { status: 204 });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(stopCallAndLog('call-abc')).resolves.toBe('stopped');
    spy.mockRestore();
  });
});
