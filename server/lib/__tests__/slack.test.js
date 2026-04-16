const { installFetchMock, mockFetchResponse, mockFetchError } = require('../../__tests__/helpers/mock-fetch');

jest.mock('../health-tracker', () => ({ touch: jest.fn() }));
jest.mock('../debug-log', () => ({ logEvent: jest.fn() }));

let sendSlackAlert, sendAdminReport, sendSystemAlert, sendSlackDM;
let touch, logEvent;

beforeEach(() => {
  installFetchMock();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  process.env.SLACK_ADMIN_CHANNEL_ID = 'C_ADMIN';
  process.env.SLACK_SALES_WEBHOOK_URL = 'https://hooks.slack.com/services/TEST';
  jest.isolateModules(() => {
    ({ sendSlackAlert, sendAdminReport, sendSystemAlert, sendSlackDM } = require('../slack'));
    ({ touch } = require('../health-tracker'));
    ({ logEvent } = require('../debug-log'));
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete global.fetch;
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ADMIN_CHANNEL_ID;
  delete process.env.SLACK_SALES_WEBHOOK_URL;
  jest.restoreAllMocks();
});

describe('sendSlackAlert (webhook)', () => {
  test('POSTs payload as JSON to webhook URL and returns true + touches health', async () => {
    mockFetchResponse('ok');
    const result = await sendSlackAlert({ text: 'hi' });
    expect(result).toBe(true);
    expect(touch).toHaveBeenCalledWith('slack');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/TEST');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ text: 'hi' });
  });

  test('returns false + skips fetch when webhook URL not set', async () => {
    delete process.env.SLACK_SALES_WEBHOOK_URL;
    expect(await sendSlackAlert({ text: 'hi' })).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns false on HTTP error + logs structured event (does NOT throw)', async () => {
    mockFetchResponse('rate limited', { status: 429 });
    const result = await sendSlackAlert({ text: 'hi' });
    expect(result).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'integration', 'slack', expect.stringMatching(/429/),
      expect.objectContaining({
        level: 'error',
        detail: expect.objectContaining({ status: 429, body: expect.stringContaining('rate limited') }),
      }),
    );
  });

  test('returns false on network error', async () => {
    mockFetchError(new Error('ECONNRESET'));
    const result = await sendSlackAlert({ text: 'hi' });
    expect(result).toBe(false);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('postBotMessage (via sendSystemAlert)', () => {
  test('POSTs to chat.postMessage with Bearer auth + returns true on ok:true', async () => {
    mockFetchResponse({ ok: true, ts: '123.456' });
    const result = await sendSystemAlert('hello', [{ type: 'section' }]);
    expect(result).toBe(true);
    expect(touch).toHaveBeenCalledWith('slack');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(opts.headers.Authorization).toBe('Bearer xoxb-test');
    expect(opts.headers['Content-Type']).toBe('application/json; charset=utf-8');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ channel: 'C_ADMIN', text: 'hello', blocks: [{ type: 'section' }] });
  });

  test('omits blocks field when not provided', async () => {
    mockFetchResponse({ ok: true });
    await sendSystemAlert('plain text');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.blocks).toBeUndefined();
  });

  test('returns false (skip) when SLACK_BOT_TOKEN not set', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(await sendSystemAlert('hi')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns false (skip) when SLACK_ADMIN_CHANNEL_ID not set', async () => {
    delete process.env.SLACK_ADMIN_CHANNEL_ID;
    expect(await sendSystemAlert('hi')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns false + logs structured event on HTTP 4xx/5xx', async () => {
    mockFetchResponse('auth error', { status: 401 });
    const result = await sendSystemAlert('hi');
    expect(result).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'integration', 'slack', expect.stringMatching(/system_alert failed.*Slack POST chat\.postMessage \(401\)/),
      expect.objectContaining({
        level: 'error',
        detail: expect.objectContaining({ status: 401, body: expect.stringContaining('auth error') }),
      }),
    );
  });

  test('returns false + logs slackError when HTTP 200 with ok:false (invalid_auth, channel_not_found, etc.)', async () => {
    // Slack's dual-failure surface: HTTP 200 with {ok:false, error:"..."}.
    // This is the whole reason !resp.ok isn't sufficient — must also check data.ok.
    mockFetchResponse({ ok: false, error: 'channel_not_found' });
    const result = await sendSystemAlert('hi');
    expect(result).toBe(false);
    expect(touch).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      'integration', 'slack', expect.stringMatching(/system_alert failed.*channel_not_found/),
      expect.objectContaining({
        level: 'error',
        detail: expect.objectContaining({
          kind: 'slack_logical',
          slackError: 'channel_not_found',
        }),
      }),
    );
  });

  test('returns false on network error — never throws', async () => {
    mockFetchError(new Error('ECONNRESET'));
    expect(await sendSystemAlert('hi')).toBe(false);
    expect(touch).not.toHaveBeenCalled();
  });
});

describe('sendAdminReport', () => {
  test('merges channel with message (admin channel)', async () => {
    mockFetchResponse({ ok: true });
    await sendAdminReport({ text: 't', blocks: [{ type: 'section' }] });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ channel: 'C_ADMIN', text: 't', blocks: [{ type: 'section' }] });
  });

  test('returns false when admin channel not configured', async () => {
    delete process.env.SLACK_ADMIN_CHANNEL_ID;
    expect(await sendAdminReport({ text: 't' })).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sendSlackDM', () => {
  test('sends to arbitrary user/DM channel ID, does NOT require SLACK_ADMIN_CHANNEL_ID', async () => {
    delete process.env.SLACK_ADMIN_CHANNEL_ID; // DMs don't need admin channel
    mockFetchResponse({ ok: true });

    const result = await sendSlackDM('U12345', 'ping');
    expect(result).toBe(true);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ channel: 'U12345', text: 'ping' });
  });

  test('returns false when bot token missing', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    expect(await sendSlackDM('U12345', 'ping')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns false on ok:false (e.g. user_not_found)', async () => {
    mockFetchResponse({ ok: false, error: 'user_not_found' });
    expect(await sendSlackDM('UBAD', 'ping')).toBe(false);
  });
});
