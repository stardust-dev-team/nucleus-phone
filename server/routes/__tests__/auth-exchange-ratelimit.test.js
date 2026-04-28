/**
 * Rate-limit integration test for POST /api/auth/exchange.
 *
 * The unit suite (auth-exchange.test.js) mocks express-rate-limit as a
 * pass-through because its module-level state pollutes test isolation.
 * That mock means the unit suite has zero coverage of "the limiter is
 * actually wired in." This file is the smoke alarm for that wiring —
 * it loads the auth router with the real limiter and asserts that the
 * 6th request inside the 10s burst window is rejected with 429.
 *
 * `jest.isolateModules` is used to get a fresh module load (and therefore
 * fresh limiter state) so this file's assertions don't bleed into other
 * suites if jest changes scheduling.
 */

const TEST_JWT_SECRET = 'test-jwt-secret';
const TEST_TENANT_ID = '66e70bed-49e9-4050-a55e-368908f78d4f';
const TEST_DIALER_CLIENT_ID = '1760ac69-78c2-49ce-9967-7a1d3e39e74f';

// Mocks must be declared at top-level — they're hoisted by jest.
jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/entra-token', () => ({
  verifyEntraIdToken: jest.fn(),
}));
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

beforeAll(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.ENTRA_TENANT_ID = TEST_TENANT_ID;
  process.env.ENTRA_DIALER_CLIENT_ID = TEST_DIALER_CLIENT_ID;
  process.env.ENABLE_NATIVE_EXCHANGE = 'true';
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.ENTRA_TENANT_ID;
  delete process.env.ENTRA_DIALER_CLIENT_ID;
  delete process.env.ENABLE_NATIVE_EXCHANGE;
});

test('burst limiter rejects the 6th request inside the 10s window with 429', async () => {
  // Force a fresh load of auth.js so its module-level limiter constants are
  // brand-new for this test only. Without isolateModules, the limiter state
  // would already be partially consumed by other suites that loaded auth.js.
  await jest.isolateModulesAsync(async () => {
    const { pool } = require('../../db');
    const { verifyEntraIdToken } = require('../../lib/entra-token');
    const { errorHandler } = require('../../middleware/error');

    // Stub the verifier so we exercise the limiter, not the JWKS path. The
    // user is resolved with oid=null on every call, so the route runs the
    // UPDATE + JWT mint and returns 200 each time — until the limiter trips.
    verifyEntraIdToken.mockResolvedValue({
      email: 'tom@joruva.com',
      oid: '00000000-0000-0000-0000-000000000001',
    });
    pool.query.mockImplementation((sql) => {
      if (/SELECT id, email, identity, role/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: 1, email: 'tom@joruva.com', identity: 'tom', role: 'admin',
            display_name: 'Tom Russo', oid: null,
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', require('../auth'));
    app.use(errorHandler);

    // Burst window is 5/10s. First five must all succeed; the 6th must 429.
    // Asserting the exact sequence (not arrayContaining) catches a future
    // change that would let some early requests fail silently.
    const responses = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(app)
        .post('/api/auth/exchange')
        .send({ idToken: 'x' });
      responses.push(r.status);
    }

    expect(responses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
