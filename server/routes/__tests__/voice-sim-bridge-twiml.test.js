/**
 * Tests for the rep-leg TwiML endpoint that scripts/sim-smoke-leg.js fetches
 * via `Calls.create({ url })`. Existence of this endpoint is the fix for
 * nucleus-phone-ufne (inline TwiML drops the <Conference statusCallback>).
 *
 * Covers:
 *   - valid conf name → 200 + conference TwiML with the right attributes
 *   - injection attempt (XML payload in conf) → 400, no <Conference> emitted
 *   - sc query missing or non-https → falls back to the prod default
 *   - sc query https → reflected into statusCallback attribute
 *   - POST (Twilio default) and GET both work
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn() }));
jest.mock('../../lib/health-tracker', () => ({ touch: jest.fn() }));
jest.mock('../../lib/slack', () => ({
  sendSystemAlert: jest.fn().mockResolvedValue(true),
  sendSlackAlert: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lib/twilio', () => {
  const actual = jest.requireActual('twilio');
  return {
    client: { conferences: jest.fn() },
    VoiceResponse: actual.twiml.VoiceResponse,
  };
});

const request = require('supertest');
const express = require('express');

let app;
beforeAll(() => {
  process.env.APP_URL = 'https://nucleus-phone-test.example.com';
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice', require('../voice'));
});

afterAll(() => {
  delete process.env.APP_URL;
});

describe('GET/POST /api/voice/sim-bridge-twiml', () => {
  test('GET with valid conf returns conference TwiML with the right attributes', async () => {
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf: 'sim-42' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<Conference');
    expect(res.text).toContain('>sim-42</Conference>');
    expect(res.text).toMatch(/statusCallbackEvent="start end join leave"/);
    expect(res.text).toMatch(/statusCallbackMethod="POST"/);
    expect(res.text).toMatch(/startConferenceOnEnter="true"/);
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
    expect(res.text).toMatch(/beep="false"/);
  });

  test('POST with valid conf also works (Twilio fetches via POST by default)', async () => {
    const res = await request(app)
      .post('/api/voice/sim-bridge-twiml')
      .query({ conf: 'sim-99' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('>sim-99</Conference>');
  });

  test('default statusCallback uses APP_URL when sc is omitted', async () => {
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf: 'dryrun-x' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/statusCallback="https:\/\/nucleus-phone-test\.example\.com\/api\/call\/status"/);
  });

  test('sc query overrides statusCallback when https://', async () => {
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf: 'sim-7', sc: 'https://webhook.site/abc-def' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/statusCallback="https:\/\/webhook\.site\/abc-def"/);
  });

  test('sc that is not https:// is rejected and falls back to default', async () => {
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf: 'sim-7', sc: 'http://attacker.example/intercept' });

    expect(res.statusCode).toBe(200);
    expect(res.text).not.toContain('attacker.example');
    expect(res.text).toMatch(/statusCallback="https:\/\/nucleus-phone-test\.example\.com\/api\/call\/status"/);
  });

  test('injection attempt in conf name → 400, no <Conference> emitted', async () => {
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf: 'evil"/><Say>haxx</Say>' });

    expect(res.statusCode).toBe(400);
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain('haxx');
    // SDK-escaped Say output (literal text, no executable injection)
    expect(res.text).toContain('<Say>Invalid conference name.</Say>');
  });

  test('missing conf → 400', async () => {
    const res = await request(app).get('/api/voice/sim-bridge-twiml');
    expect(res.statusCode).toBe(400);
    expect(res.text).not.toContain('<Conference');
  });

  test('conf with whitespace or special chars → 400', async () => {
    const cases = ['sim 42', 'sim.42', 'sim@42', 'sim/42'];
    for (const conf of cases) {
      const res = await request(app)
        .get('/api/voice/sim-bridge-twiml')
        .query({ conf });
      expect(res.statusCode).toBe(400);
    }
  });

  test('allowed chars: alphanumeric, underscore, dash', async () => {
    const conf = 'dryrun_abc-DEF-123';
    const res = await request(app)
      .get('/api/voice/sim-bridge-twiml')
      .query({ conf });
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${conf}</Conference>`);
  });
});
