const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

let uploadToFireflies;

beforeEach(() => {
  installFetchMock();
  process.env.FIREFLIES_API_KEY = 'ff-test-key';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'twilio-secret';
  jest.isolateModules(() => {
    ({ uploadToFireflies } = require('../fireflies'));
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete global.fetch;
  delete process.env.FIREFLIES_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  jest.restoreAllMocks();
});

const META = {
  callerIdentity: 'britt',
  callerDisplayName: 'Britt',
  leadName: 'Jane Doe',
  leadCompany: 'Acme Corp',
  leadEmail: 'jane@acme.com',
  leadPhone: '+16025551234',
};

describe('uploadToFireflies', () => {
  test('POSTs GraphQL mutation to Fireflies with Bearer auth + Twilio-authed URL', async () => {
    mockFetchResponse({ data: { uploadAudio: { success: true, title: 'test' } } });
    const result = await uploadToFireflies('https://api.twilio.com/recordings/RE123', META);
    expect(result.success).toBe(true);
    expect(result.title).toMatch(/CNC Call — Jane Doe at Acme Corp/);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.fireflies.ai/graphql');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer ff-test-key');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.query).toMatch(/uploadAudio/);
    expect(body.variables.input.url).toBe(
      'https://ACtest:twilio-secret@api.twilio.com/recordings/RE123.mp3',
    );
    expect(body.variables.input.attendees).toHaveLength(2);
    expect(body.variables.input.attendees[0].displayName).toBe('Britt');
  });

  test('includes coach attendee when coachIdentity is provided', async () => {
    mockFetchResponse({ data: { uploadAudio: { success: true } } });
    await uploadToFireflies('https://api.twilio.com/rec/1', { ...META, coachIdentity: 'tom' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.variables.input.attendees).toHaveLength(3);
    expect(body.variables.input.attendees[2].displayName).toBe('Tom Russo');
  });

  test('returns soft-fail when FIREFLIES_API_KEY not set', async () => {
    delete process.env.FIREFLIES_API_KEY;
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result).toEqual({ success: false, reason: 'no_api_key' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns {success:false, reason:"http_error"} with structured status on HTTP non-2xx (bugfix: was unchecked)', async () => {
    mockFetchResponse('{"error":"unauthorized"}', { status: 401 });
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('http_error');
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/Fireflies POST graphql \(401\)/);
  });

  test('returns {success:false, reason:"api_error"} on GraphQL errors (HTTP 200 with errors[])', async () => {
    mockFetchResponse({ errors: [{ message: 'Invalid URL' }] });
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('api_error');
    expect(result.errors).toEqual([{ message: 'Invalid URL' }]);
  });

  test('returns {success:false, reason:"network_error"} on network failure', async () => {
    mockFetchError(new Error('ECONNRESET'));
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('network_error');
    expect(result.error).toMatch(/ECONNRESET/);
    expect(result.status).toBeUndefined();
  });

  test('returns {success:false, reason:"parse_error"} when 200 response has invalid JSON', async () => {
    // Edge case: HTTP 200 passes !res.ok check, but body isn't valid JSON.
    // res.json() throws SyntaxError — should be classified as parse_error, not network_error.
    mockFetchResponse('not valid json {{{{');
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('parse_error');
    expect(result.status).toBeUndefined();
  });

  test('never throws — all failure modes return an object (fire-and-forget contract)', async () => {
    mockFetchResponse('not json at all', { status: 500 });
    const result = await uploadToFireflies('https://api.twilio.com/rec/1', META);
    expect(result.success).toBe(false);
    // Should not have thrown — we got a result back
    expect(typeof result.reason).toBe('string');
  });
});
