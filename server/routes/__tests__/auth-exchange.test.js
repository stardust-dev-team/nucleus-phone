/**
 * Tests for POST /api/auth/exchange (nucleus-phone-t3x).
 *
 * Mocks the pg pool and the Entra id_token verifier — production code paths
 * in the route are exercised end-to-end (kill-switch, body parse, user lookup,
 * oid update, JWT mint).
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/entra-token', () => ({
  verifyEntraIdToken: jest.fn(),
}));
// Pass-through rate-limit so the unit suite isn't tripping the burst window.
// Real limiter behavior is asserted in auth-exchange-ratelimit.test.js, which
// uses jest.isolateModules to get a fresh limiter for that single test.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
// Don't import the real msal — auth.js requires it at top-of-file but the
// exchange route never touches it. Stubbing avoids loading the heavy MSAL deps
// + dotenv side effects in tests.
jest.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: jest.fn(),
}));
jest.mock('../../lib/crypto', () => ({
  encrypt: jest.fn().mockReturnValue('ciphertext'),
  decrypt: jest.fn(),
}));
jest.mock('../../lib/debug-log', () => ({
  logEvent: jest.fn(),
  flush: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { verifyEntraIdToken } = require('../../lib/entra-token');

const TEST_JWT_SECRET = 'test-jwt-secret';
const TEST_TENANT_ID = '66e70bed-49e9-4050-a55e-368908f78d4f';
const TEST_DIALER_CLIENT_ID = '1760ac69-78c2-49ce-9967-7a1d3e39e74f';

const SAMPLE_USER = {
  id: 42,
  email: 'tom@joruva.com',
  identity: 'tom',
  role: 'admin',
  display_name: 'Tom Russo',
  oid: null,
};

const SAMPLE_CLAIMS = {
  email: 'tom@joruva.com',
  oid: '00000000-0000-0000-0000-000000000001',
  name: 'Tom Russo',
};

let app;

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', require('../auth'));
  // Match production error handling so async rejections surface as 500s
  a.use(require('../../middleware/error').errorHandler);
  return a;
}

beforeAll(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ENTRA_TENANT_ID = TEST_TENANT_ID;
  process.env.ENTRA_DIALER_CLIENT_ID = TEST_DIALER_CLIENT_ID;
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.ENTRA_TENANT_ID;
  delete process.env.ENTRA_DIALER_CLIENT_ID;
  delete process.env.ENABLE_NATIVE_EXCHANGE;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  process.env.ENABLE_NATIVE_EXCHANGE = 'true';
  app = buildApp();
});

/* ─────────────────────── Kill-switch ─────────────────────── */

describe('kill-switch', () => {
  test('returns 503 when ENABLE_NATIVE_EXCHANGE !== "true"', async () => {
    delete process.env.ENABLE_NATIVE_EXCHANGE;
    app = buildApp();
    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'whatever' })
      .expect(503);
    expect(res.body).toEqual({ error: 'Native exchange disabled' });
    expect(verifyEntraIdToken).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 503 when ENABLE_NATIVE_EXCHANGE === "false"', async () => {
    process.env.ENABLE_NATIVE_EXCHANGE = 'false';
    app = buildApp();
    await request(app).post('/api/auth/exchange').send({ idToken: 'x' }).expect(503);
  });
});

/* ─────────────────────── Happy path ─────────────────────── */

describe('happy path', () => {
  test('200 + token + user when claims valid and user active', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query
      // findActiveUserByEmail — user has no oid yet
      .mockResolvedValueOnce({ rows: [SAMPLE_USER], rowCount: 1 })
      // UPDATE oid (null → claims.oid)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'valid-id-token' })
      .expect(200);

    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({
      id: SAMPLE_USER.id,
      email: SAMPLE_USER.email,
      identity: SAMPLE_USER.identity,
      role: SAMPLE_USER.role,
      displayName: SAMPLE_USER.display_name,
    });
    expect(res.body.expiresAt).toEqual(expect.any(Number));
    // 30-day TTL ≈ 2,592,000s — sanity-check it's roughly that
    expect(res.body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 24 * 60 * 60);

    // Decoded JWT should carry only userId (matches sessionAuth's expectation)
    const decoded = jwt.verify(res.body.token, TEST_JWT_SECRET);
    expect(decoded.userId).toBe(SAMPLE_USER.id);

    // No cookie set on the response
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('400 on missing idToken', async () => {
    await request(app)
      .post('/api/auth/exchange')
      .send({})
      .expect(400);
    expect(verifyEntraIdToken).not.toHaveBeenCalled();
  });

  test('400 on non-string idToken', async () => {
    await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 123 })
      .expect(400);
  });
});

/* ─────────────────────── User lookup ─────────────────────── */

describe('user lookup', () => {
  test('403 when no active user matches email', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'x' })
      .expect(403);
    expect(res.body.error).toContain('No active');
  });

  // findActiveUserByEmail's WHERE clause already excludes is_active=FALSE rows,
  // so an inactive user simply returns no row — same 403 path as missing user.
  test('403 when user is_active=false (filtered out by SQL)', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).post('/api/auth/exchange').send({ idToken: 'x' }).expect(403);
  });
});

/* ─────────────────────── Token verification failures ─────────────────────── */

describe('token verification failures', () => {
  test.each([
    ['bad audience',  Object.assign(new Error('jwt audience invalid'), { name: 'JsonWebTokenError' })],
    ['bad issuer',    Object.assign(new Error('jwt issuer invalid'),   { name: 'JsonWebTokenError' })],
    ['bad tenant',    new Error('tid mismatch: expected X, got Y')],
    ['expired token', Object.assign(new Error('jwt expired'),          { name: 'TokenExpiredError' })],
    ['bad signature', Object.assign(new Error('invalid signature'),    { name: 'JsonWebTokenError' })],
  ])('401 on %s', async (_label, error) => {
    verifyEntraIdToken.mockRejectedValue(error);
    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'x' })
      .expect(401);
    expect(res.body).toEqual({ error: 'Invalid id_token' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});

/* ─────────────────────── OID handling ─────────────────────── */

describe('oid handling', () => {
  test('UPDATE oid on first authenticated request (oid was null)', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_USER], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).post('/api/auth/exchange').send({ idToken: 'x' }).expect(200);

    // Second call is the UPDATE
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE nucleus_phone_users SET oid/);
    expect(updateCall[1]).toEqual([SAMPLE_CLAIMS.oid, SAMPLE_USER.id]);
  });

  test('409 when stored oid differs — refuses silent overwrite', async () => {
    // If a user's email gets re-mapped to a different Entra principal (admin
    // merged accounts, mailbox handoff), the new id_token's oid will differ
    // from the stored oid. Silently overwriting would let whoever logs in
    // last take over the row. Force admin intervention instead.
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query.mockResolvedValueOnce({
      rows: [{ ...SAMPLE_USER, oid: '00000000-0000-0000-0000-000000000999' }],
      rowCount: 1,
    });

    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'x' })
      .expect(409);
    expect(res.body.error).toMatch(/oid mismatch/);
    // No UPDATE should have fired
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('skips UPDATE when stored oid already matches', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query.mockResolvedValueOnce({
      rows: [{ ...SAMPLE_USER, oid: SAMPLE_CLAIMS.oid }],
      rowCount: 1,
    });

    await request(app).post('/api/auth/exchange').send({ idToken: 'x' }).expect(200);
    // One DB call only — no UPDATE
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('409 on oid collision (UNIQUE constraint violation)', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_USER], rowCount: 1 })
      .mockRejectedValueOnce(uniqueViolation);

    const res = await request(app)
      .post('/api/auth/exchange')
      .send({ idToken: 'x' })
      .expect(409);
    expect(res.body.error).toMatch(/oid already bound/);
  });

  test('rethrows non-collision DB errors → 500', async () => {
    verifyEntraIdToken.mockResolvedValue(SAMPLE_CLAIMS);
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_USER], rowCount: 1 })
      .mockRejectedValueOnce(new Error('connection lost'));

    await request(app).post('/api/auth/exchange').send({ idToken: 'x' }).expect(500);
  });
});
