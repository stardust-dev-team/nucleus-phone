// nucleus-phone-zht.3: POST /api/voice-push/register
//
// Path B (token-only storage) — server doesn't talk to Twilio's binding API,
// the iOS SDK does. This file tests:
//  - auth precedence (bearer wins, api-key rejected with 403)
//  - body validation (hex format, length, environment allowlist)
//  - environment → credential SID resolution (production vs sandbox)
//  - sandbox 503 when TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX is unset
//  - upsert keyed by user_id (re-register replaces prior row)

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn(), flush: jest.fn() }));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { logEvent } = require('../../lib/debug-log');
const { __testSetUser, bearerOrApiKeyOrSession } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');

const API_KEY = 'test-api-key';
const PROD_SID = 'CRprodcredentialsid000000000000000';
const SANDBOX_SID = 'CRsandboxcredentialsid000000000000';
const VALID_TOKEN = 'a'.repeat(64); // 64-char hex, the Apple norm

let nextUserId = 5000;
function mockBearerUser(identity, role = 'caller') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@joruva.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/api/voice-push',
    bearerOrApiKeyOrSession,
    rbac('external_caller'),
    require('../voice-push'),
  );
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
  delete process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID;
  delete process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID = PROD_SID;
  delete process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX;
});

describe('POST /api/voice-push/register — auth', () => {
  test('rejects unauthenticated requests (401)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .send({ pushToken: VALID_TOKEN, environment: 'production' })
      .expect(401);
  });

  test('rejects api_key callers with 403 (registration is per-user only)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('x-api-key', API_KEY)
      .send({ pushToken: VALID_TOKEN, environment: 'production' })
      .expect(403);

    expect(pool.query).not.toHaveBeenCalled();
  });

  test('accepts valid bearer JWT and upserts on user_id', async () => {
    const userId = mockBearerUser('tom', 'admin');

    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'production' })
      .expect(204);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO nucleus_phone_voip_tokens/);
    expect(sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(params).toEqual([userId, VALID_TOKEN, PROD_SID, 'production']);
  });
});

describe('POST /api/voice-push/register — body validation', () => {
  beforeEach(() => mockBearerUser('kate'));

  test('rejects missing pushToken (400)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ environment: 'production' })
      .expect(400);

    expect(pool.query).not.toHaveBeenCalled();
  });

  test('rejects non-hex pushToken (400)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: 'not-hex-' + 'a'.repeat(56), environment: 'production' })
      .expect(400);
  });

  test('rejects too-short pushToken (< 32 chars)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: 'a'.repeat(31), environment: 'production' })
      .expect(400);
  });

  test('rejects too-long pushToken (> 256 chars)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: 'a'.repeat(257), environment: 'production' })
      .expect(400);
  });

  test('rejects unknown environment value (400)', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'staging' })
      .expect(400);
  });

  test('accepts mixed-case hex and lowercases before storing', async () => {
    const mixed = 'A1b2'.repeat(16); // 64 chars, mixed case
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: mixed, environment: 'production' })
      .expect(204);

    const params = pool.query.mock.calls[0][1];
    expect(params[1]).toBe(mixed.toLowerCase());
  });
});

describe('POST /api/voice-push/register — environment routing', () => {
  beforeEach(() => mockBearerUser('paul'));

  test('production uses TWILIO_VOICE_PUSH_CREDENTIAL_SID', async () => {
    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'production' })
      .expect(204);

    expect(pool.query.mock.calls[0][1][2]).toBe(PROD_SID);
  });

  test('sandbox without _SANDBOX env returns 503 (deferred per plan)', async () => {
    // _SANDBOX is intentionally unset by beforeEach above
    const res = await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'sandbox' })
      .expect(503);

    expect(res.body.error).toMatch(/TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('sandbox with _SANDBOX env uses sandbox credential SID', async () => {
    process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX = SANDBOX_SID;

    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'sandbox' })
      .expect(204);

    expect(pool.query.mock.calls[0][1][2]).toBe(SANDBOX_SID);
    expect(pool.query.mock.calls[0][1][3]).toBe('sandbox');
  });
});

describe('POST /api/voice-push/register — audit log', () => {
  test('emits debug_events state_change after upsert with credential SID + token suffix', async () => {
    mockBearerUser('lily');

    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'production' })
      .expect(204);

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith(
      'state_change',
      'voice-push',
      'voip token registered',
      {
        caller: 'lily',
        detail: {
          environment: 'production',
          credentialSid: PROD_SID,
          tokenSuffix: VALID_TOKEN.slice(-8),
        },
      },
    );
  });

  test('does NOT emit on validation failure (logEvent only fires after successful upsert)', async () => {
    mockBearerUser('alex');

    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: 'not-hex', environment: 'production' })
      .expect(400);

    expect(logEvent).not.toHaveBeenCalled();
  });

  test('does NOT emit on sandbox 503 (no row was written)', async () => {
    mockBearerUser('britt');

    await request(app)
      .post('/api/voice-push/register')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ pushToken: VALID_TOKEN, environment: 'sandbox' })
      .expect(503);

    expect(logEvent).not.toHaveBeenCalled();
  });
});
