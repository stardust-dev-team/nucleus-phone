const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let createOutboundCall, stopCall, getCall;

beforeEach(() => {
  installFetchMock();
  process.env.VAPI_API_KEY = 'test-key';
  process.env.VAPI_PRACTICE_PHONE_ID = 'phone-123';
  jest.isolateModules(() => {
    ({ createOutboundCall, stopCall, getCall } = require('../vapi'));
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

  test('returns {} on 204 empty body', async () => {
    mockFetchResponse('', { status: 204 });
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

  test('propagates network errors', async () => {
    mockFetchError(new Error('ECONNRESET'));
    await expect(stopCall('call-id')).rejects.toThrow(/ECONNRESET/);
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

describe('auth', () => {
  test('throws if VAPI_API_KEY is not set', async () => {
    delete process.env.VAPI_API_KEY;
    await expect(stopCall('call-id')).rejects.toThrow(/VAPI_API_KEY not set/);
  });
});
