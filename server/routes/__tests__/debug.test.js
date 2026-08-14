jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/health-tracker', () => ({
  getAll: jest.fn().mockReturnValue({
    'vapi.webhook': { lastSeen: Date.now(), ageMinutes: 0 },
    'slack': { lastSeen: Date.now() - 300000, ageMinutes: 5 },
  }),
}));
jest.mock('../../lib/live-analysis', () => ({
  getConnectionStats: jest.fn().mockReturnValue({
    websockets: [{ callId: 'sim-42', listenerCount: 1 }],
    total: 1,
  }),
  attachWebSocket: jest.fn(),
  broadcast: jest.fn(),
  cleanupCall: jest.fn(),
  getCallEquipment: jest.fn(),
}));

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { apiKeyAuth, __testSetUser } = require('../../middleware/auth');
const { rbac } = require('../../middleware/rbac');
const { pool } = require('../../db');


afterEach(closeLoopbackServers);
const API_KEY = 'test-api-key';

let nextUserId = 9000;
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
  app.use('/api/debug', apiKeyAuth, rbac('admin'), require('../debug'));
  return app;
}

beforeEach(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  pool.query.mockReset();
});

afterEach(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

describe('GET /api/debug/events', () => {
  test('returns 403 for non-admin', async () => {
    loginAs('caller');
    const app = makeApp();
    // Use session auth (Cookie), NOT x-api-key (which auto-grants admin)
    const res = await request(await listenLoopback(app))
      .get('/api/debug/events')
      .set('Cookie', 'nucleus_session=tok');
    expect(res.status).toBe(403);
  });

  test('returns events for admin', async () => {
    loginAs('admin', 'tom');
    const app = makeApp();
    const mockEvents = [
      { id: 1, ts: '2026-04-13T00:00:00Z', category: 'webhook', source: 'sim.webhook', level: 'info', summary: 'test', detail: null, call_id: null, caller_identity: null },
    ];
    pool.query
      .mockResolvedValueOnce({ rows: mockEvents })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const res = await request(await listenLoopback(app))
      .get('/api/debug/events')
      .set('x-api-key', API_KEY)
      .set('Cookie', 'nucleus_session=tok');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test('applies category filter', async () => {
    loginAs('admin', 'tom');
    const app = makeApp();
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    await request(await listenLoopback(app))
      .get('/api/debug/events?category=error')
      .set('x-api-key', API_KEY)
      .set('Cookie', 'nucleus_session=tok');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('category = $1');
    expect(params[0]).toBe('error');
  });
});

describe('GET /api/debug/health', () => {
  test('returns health status for admin', async () => {
    loginAs('admin', 'tom');
    const app = makeApp();
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

    const res = await request(await listenLoopback(app))
      .get('/api/debug/health')
      .set('x-api-key', API_KEY)
      .set('Cookie', 'nucleus_session=tok');
    expect(res.status).toBe(200);
    expect(res.body.db).toHaveProperty('status', 'ok');
    expect(res.body.db).toHaveProperty('latencyMs');
    expect(res.body).toHaveProperty('integrations');
    expect(res.body).toHaveProperty('uptime_seconds');
    expect(res.body.integrations['vapi.webhook']).toHaveProperty('lastSeen');
  });
});

describe('GET /api/debug/connections', () => {
  test('returns WebSocket stats', async () => {
    loginAs('admin', 'tom');
    const app = makeApp();

    const res = await request(await listenLoopback(app))
      .get('/api/debug/connections')
      .set('x-api-key', API_KEY)
      .set('Cookie', 'nucleus_session=tok');
    expect(res.status).toBe(200);
    expect(res.body.websockets).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('GET /api/debug/sweep', () => {
  test('returns sweep events', async () => {
    loginAs('admin', 'tom');
    const app = makeApp();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, ts: '2026-04-13', source: 'stale-sweep', level: 'info', summary: 'sweep complete', detail: null }] });

    const res = await request(await listenLoopback(app))
      .get('/api/debug/sweep')
      .set('x-api-key', API_KEY)
      .set('Cookie', 'nucleus_session=tok');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
  });
});
