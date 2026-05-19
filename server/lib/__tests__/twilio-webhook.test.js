// Verifies the lazy-eval contract: NODE_ENV is read on every request, not
// frozen at module-load. The earlier per-route `twilio.webhook({ validate:
// process.env.NODE_ENV === 'production' })` pattern would have failed this
// test — toggling NODE_ENV between calls had no effect because the validate
// flag was captured once at require time. d74 closure depended on this.

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const { makeTwilioWebhook } = require('../twilio-webhook');

/**
 * Reimplements Twilio's signature algorithm:
 *   base64(HMAC-SHA1(authToken, url + sortedKey1 + value1 + sortedKey2 + value2...))
 * Matches twilio-node `getExpectedTwilioSignature` exactly. Lifted into the
 * test so we can sign requests ourselves (the SDK doesn't export it cleanly).
 */
function signTwilio(authToken, url, params) {
  const sorted = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], '');
  return crypto.createHmac('sha1', authToken).update(url + sorted).digest('base64');
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post('/hook', makeTwilioWebhook('/hook'), (_req, res) => res.sendStatus(204));
  return app;
}

describe('makeTwilioWebhook lazy NODE_ENV evaluation', () => {
  const originalEnv = process.env.NODE_ENV;
  afterAll(() => { process.env.NODE_ENV = originalEnv; });

  test('NODE_ENV=test: passes through (no signature required)', async () => {
    process.env.NODE_ENV = 'test';
    await request(makeApp()).post('/hook').send({}).expect(204);
  });

  test('NODE_ENV=production: 400 without X-Twilio-Signature', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(makeApp()).post('/hook').send({});
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/X-Twilio-Signature/);
  });

  test('NODE_ENV toggled between requests on a SHARED app: each request sees current env', async () => {
    // Critical: same Express app, same middleware closure, env flips between
    // calls. Old eager-eval pattern would freeze whichever value was first
    // and ignore the second toggle — exactly the d74 footgun.
    const app = makeApp();
    process.env.NODE_ENV = 'test';
    await request(app).post('/hook').send({}).expect(204);
    process.env.NODE_ENV = 'production';
    const blocked = await request(app).post('/hook').send({});
    expect(blocked.status).toBe(400);
    process.env.NODE_ENV = 'test';
    await request(app).post('/hook').send({}).expect(204);
  });
});

/**
 * Regression test for the 2026-05-19 dial-complete 403 bug. Pre-fix code
 * passed `url: ${baseUrl}${path}` (no query string) to twilio.webhook();
 * Twilio computes its signature over the FULL request URL including query
 * string, so action-URL callbacks like
 *   /api/voice/incoming/dial-complete?conf=X&from=Y
 * silently 403'd in production for months. Bug was masked on PSTN inbound
 * because Twilio falls back to the inline TwiML safety net after a 403 —
 * but it surfaced when iOS dial timed out and Twilio escalated to the
 * number-level fallback URL ("technical difficulties" message).
 */
describe('makeTwilioWebhook signature validation: URL must include query string', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthToken = process.env.TWILIO_AUTH_TOKEN;
  const originalAppUrl = process.env.APP_URL;
  const TEST_TOKEN = 'test-auth-token-12345';
  const BASE = 'https://nucleus-phone.onrender.com';

  beforeAll(() => {
    process.env.NODE_ENV = 'production';
    process.env.TWILIO_AUTH_TOKEN = TEST_TOKEN;
    process.env.APP_URL = BASE;
  });
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = originalAuthToken;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  });

  test('accepts a request signed over URL+query — proves validator uses full URL not just path', async () => {
    const app = makeApp();
    const path = '/hook?conf=nucleus-inbound-ios-abc-123&from=%2B14155551212';
    const body = { CallSid: 'CA-test-1', DialCallStatus: 'no-answer' };
    const signature = signTwilio(TEST_TOKEN, `${BASE}${path}`, body);

    const res = await request(app)
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', signature)
      .send(body);

    expect(res.status).toBe(204);
  });

  test('rejects a request signed over path-only URL — the BUG signature, must NOT validate', async () => {
    const app = makeApp();
    const path = '/hook?conf=nucleus-inbound-ios-abc-123&from=%2B14155551212';
    const body = { CallSid: 'CA-test-2', DialCallStatus: 'no-answer' };
    // Sign over the path WITHOUT query string — the pre-fix bug's signature
    // shape. Should be rejected because the validator (correctly) reconstructs
    // the URL with query string.
    const buggySignature = signTwilio(TEST_TOKEN, `${BASE}/hook`, body);

    const res = await request(app)
      .post(path)
      .type('form')
      .set('X-Twilio-Signature', buggySignature)
      .send(body);

    expect(res.status).toBe(403);
  });
});
