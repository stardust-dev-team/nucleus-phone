// zht.2: ?mode=mobile flag wires generateAccessToken({ incomingAllow: true })
// for the native iOS dialer. PWA continues to call without the param (default
// incomingAllow:false). Tests stub generateAccessToken and assert the args
// passed through — the lib-level Twilio JWT encoding is not under test here.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/twilio', () => ({
  generateAccessToken: jest.fn(() => 'fake-jwt'),
}));
jest.mock('../auth', () => ({
  isValidIdentity: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const express = require('express');
const { generateAccessToken } = require('../../lib/twilio');
const { pool } = require('../../db');
const { apiKeyAuth } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');

const API_KEY = 'test-api-key';

let app;
let appWithSession;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  // Mount with apiKeyAuth so we can drive the test via x-api-key (synthetic
  // admin principal). The composer-precedence path is covered separately in
  // history.test.js.
  app.use('/api/token', apiKeyAuth, rbac('external_caller'), require('../token'));

  // Second app mount with a fake session-style auth that injects a real
  // req.user.id — needed to exercise the nucleus_phone_voip_tokens lookup
  // path (the API-key principal has id:0 and skips the lookup).
  appWithSession = express();
  appWithSession.use(express.json());
  appWithSession.use((req, _res, next) => {
    req.user = { id: 1, identity: 'tom', authSource: 'session', role: 'admin' };
    next();
  });
  appWithSession.use('/api/token', rbac('external_caller'), require('../token'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
});

beforeEach(() => {
  generateAccessToken.mockClear();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('GET /api/token', () => {
  test('default (no mode) → incomingAllow:false (PWA path unchanged)', async () => {
    const res = await request(app)
      .get('/api/token?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ token: 'fake-jwt', identity: 'tom' });
    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: false });
  });

  test('?mode=mobile → incomingAllow:true (iOS opt-in for TVOCallInvite)', async () => {
    await request(app)
      .get('/api/token?identity=tom&mode=mobile')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: true });
  });

  test('?mode=anything-else → incomingAllow:false (only "mobile" opts in)', async () => {
    await request(app)
      .get('/api/token?identity=tom&mode=desktop')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: false });
  });
});

// Regression for the 2026-05-19 APNs 52143 root cause: iOS register() was
// binding to Twilio's auto-picked (legacy Flex) APN credential because the
// VoiceGrant had no pushCredentialSid. /api/token?mode=mobile now looks up
// the user's registered env in nucleus_phone_voip_tokens and forwards the
// matching credential_sid into the grant.
describe('GET /api/token — pushCredentialSid lookup (session auth, mobile mode)', () => {
  test('mobile + session user + voip_tokens row → forwards credential_sid', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ credential_sid: 'CRsandbox123' }],
      rowCount: 1,
    });

    await request(appWithSession).get('/api/token?mode=mobile').expect(200);

    // Verify the lookup ran with the right user_id (drift sentinel: if
    // someone changes the SQL to filter by something else, this catches it).
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/nucleus_phone_voip_tokens/),
      [1],
    );
    expect(generateAccessToken).toHaveBeenCalledWith('tom', {
      incomingAllow: true,
      pushCredentialSid: 'CRsandbox123',
    });
  });

  test('mobile + session user + NO voip_tokens row → 503 (fail loud, Linus #1)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(appWithSession).get('/api/token?mode=mobile').expect(503);

    // Body must point the iOS app at the fix path. The error keeps
    // VoIPPushRegistrar.swift:95's 503-handler from confusing this with
    // the "deploy lacks sandbox credential" 503 (different cause, same
    // status code). Keep both messages searchable.
    expect(res.body.error).toBe('No push credential registered');
    expect(res.body.detail).toMatch(/voice-push\/register/);
    // Crucially: no degraded token issued. Pre-fix code silently fell
    // through with null pushCredentialSid — exactly the bug shape that
    // produced APNs 52143. Asserting generateAccessToken was NEVER
    // called is the regression sentinel.
    expect(generateAccessToken).not.toHaveBeenCalled();
  });

  test('NO mode (default) → no lookup runs, no pushCredentialSid forwarded', async () => {
    await request(appWithSession).get('/api/token').expect(200);

    expect(pool.query).not.toHaveBeenCalled();
    expect(generateAccessToken).toHaveBeenCalledWith('tom', { incomingAllow: false });
  });

  test('mobile + DB query throws → 503 (fail loud, Linus #1)', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await request(appWithSession).get('/api/token?mode=mobile').expect(503);
      expect(res.body.error).toBe('Push credential lookup failed');
      expect(generateAccessToken).not.toHaveBeenCalled();
      // We DO log to console for ops visibility — but the response itself
      // is the load-bearing signal, not the log line.
      expect(errSpy).toHaveBeenCalledWith(
        'token: voip_tokens lookup failed:',
        'connection refused',
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
