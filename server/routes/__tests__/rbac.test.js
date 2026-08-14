/**
 * rbac.test.js — proves the role × route matrix defined by nucleus-phone-e5p.
 *
 * For each role (external_caller, caller, admin) we hit a representative
 * endpoint and assert the expected allow/deny. This is the backstop: if a
 * future refactor accidentally widens access, this suite catches it.
 *
 * The test app mounts only the endpoints we care about, with the same
 * auth/rbac middleware composition as server/index.js. This keeps the suite
 * fast and decouples it from the full DB wiring.
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { apiKeyAuth, sessionAuth, __testSetUser } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');
const { pool } = require('../../db');


afterEach(closeLoopbackServers);
const API_KEY = 'test-api-key';

let nextUserId = 5000;
function loginAs(role, identity = 'test') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@example.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // Representative endpoints — one per role tier we need to verify.
  app.get('/ext', apiKeyAuth, rbac('external_caller'), (_req, res) => res.json({ ok: true }));
  app.get('/caller', apiKeyAuth, rbac('caller'), (_req, res) => res.json({ ok: true }));
  app.get('/admin', apiKeyAuth, rbac('admin'), (_req, res) => res.json({ ok: true }));

  return app;
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = makeApp();
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('RBAC role hierarchy', () => {
  test('no auth → 401 on every tier', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('no session'); });
    await request(await listenLoopback(app)).get('/ext').expect(401);
    await request(await listenLoopback(app)).get('/caller').expect(401);
    await request(await listenLoopback(app)).get('/admin').expect(401);
  });

  test('external_caller: ext=200, caller=403, admin=403', async () => {
    loginAs('external_caller');
    await request(await listenLoopback(app)).get('/ext').set('Cookie', 'nucleus_session=t').expect(200);

    loginAs('external_caller');
    await request(await listenLoopback(app)).get('/caller').set('Cookie', 'nucleus_session=t').expect(403);

    loginAs('external_caller');
    await request(await listenLoopback(app)).get('/admin').set('Cookie', 'nucleus_session=t').expect(403);
  });

  test('caller: ext=200, caller=200, admin=403', async () => {
    loginAs('caller');
    await request(await listenLoopback(app)).get('/ext').set('Cookie', 'nucleus_session=t').expect(200);

    loginAs('caller');
    await request(await listenLoopback(app)).get('/caller').set('Cookie', 'nucleus_session=t').expect(200);

    loginAs('caller');
    await request(await listenLoopback(app)).get('/admin').set('Cookie', 'nucleus_session=t').expect(403);
  });

  test('admin: ext=200, caller=200, admin=200', async () => {
    loginAs('admin');
    await request(await listenLoopback(app)).get('/ext').set('Cookie', 'nucleus_session=t').expect(200);

    loginAs('admin');
    await request(await listenLoopback(app)).get('/caller').set('Cookie', 'nucleus_session=t').expect(200);

    loginAs('admin');
    await request(await listenLoopback(app)).get('/admin').set('Cookie', 'nucleus_session=t').expect(200);
  });

  test('API key resolves to synthetic admin — passes every tier', async () => {
    await request(await listenLoopback(app)).get('/ext').set('x-api-key', API_KEY).expect(200);
    await request(await listenLoopback(app)).get('/caller').set('x-api-key', API_KEY).expect(200);
    await request(await listenLoopback(app)).get('/admin').set('x-api-key', API_KEY).expect(200);
  });

  test('wrong API key → 401, does not fall through to session', async () => {
    await request(await listenLoopback(app)).get('/admin').set('x-api-key', 'nope').expect(401);
  });

  test('deactivated user → 401 even with valid JWT', async () => {
    // Mock loadUserById path: jwt.verify returns a userId the cache doesn't
    // have, and the pool.query for user lookup returns is_active=false.
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 9999, email: 'revoked@example.com', identity: 'revoked',
        role: 'caller', display_name: 'Revoked', is_active: false,
      }],
    });
    jwt.verify.mockReturnValue({ userId: 9999 });

    await request(await listenLoopback(app)).get('/ext').set('Cookie', 'nucleus_session=t').expect(401);
  });
});

describe('CSRF guard (state-changing session requests)', () => {
  function makeCsrfApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.post('/mutate', sessionAuth, rbac('external_caller'), (_req, res) => res.json({ ok: true }));
    return app;
  }

  test('POST via cookie without X-Requested-With → 403', async () => {
    const csrfApp = makeCsrfApp();
    loginAs('caller');
    await request(await listenLoopback(csrfApp)).post('/mutate').set('Cookie', 'nucleus_session=t').expect(403);
  });

  test('POST via cookie WITH X-Requested-With → 200', async () => {
    const csrfApp = makeCsrfApp();
    loginAs('caller');
    await request(await listenLoopback(csrfApp))
      .post('/mutate')
      .set('Cookie', 'nucleus_session=t')
      .set('X-Requested-With', 'XMLHttpRequest')
      .expect(200);
  });
});
