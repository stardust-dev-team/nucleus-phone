// Flush microtask queue so fire-and-forget .then()/.catch() chains settle.
// Works because history.js chains have no intermediate awaits. If that changes,
// increase the flush count here — single point of fix.
const flushFireAndForget = () => new Promise((r) => setImmediate(r));

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  formatCallAlert: jest.fn().mockReturnValue({ text: 'mock alert' }),
}));
jest.mock('../../lib/hubspot', () => ({
  addNoteToContact: jest.fn().mockResolvedValue({}),
  getContact: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/interaction-sync', () => ({
  syncInteraction: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../lib/format', () => ({
  formatDuration: jest.fn().mockReturnValue('5m 42s'),
}));
jest.mock('../../lib/customer-lookup', () => ({
  lookupCustomer: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/email-sender', () => ({
  sendFollowUpEmail: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { sendSlackAlert, formatCallAlert } = require('../../lib/slack');
const { addNoteToContact, getContact } = require('../../lib/hubspot');
const { syncInteraction } = require('../../lib/interaction-sync');
const { lookupCustomer } = require('../../lib/customer-lookup');
const { sendFollowUpEmail } = require('../../lib/email-sender');
const { __testSetUser, invalidateUser } = require('../../middleware/auth');

const API_KEY = 'test-api-key';

const SAMPLE_CALL = {
  id: 1,
  created_at: '2026-03-25T10:00:00Z',
  conference_name: 'nucleus-call-abc',
  caller_identity: 'ryann',
  lead_phone: '+16025551234',
  lead_name: 'Jane Doe',
  lead_company: 'Acme Corp',
  hubspot_contact_id: '101',
  direction: 'outbound',
  status: 'completed',
  duration_seconds: 342,
  disposition: null,
  qualification: null,
  products_discussed: null,
  notes: null,
  recording_url: null,
  recording_duration: null,
  fireflies_uploaded: false,
  ci_summary: null,
  sentiment: null,
  competitive_intel: null,
  ci_products: null,
};

let nextUserId = 1000;
function mockSession(identity, role = 'caller') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@joruva.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/history', require('../history'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── GET /api/history ───────────── */

describe('GET /api/history', () => {
  test('returns 401 without session cookie', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history').expect(401);
  });

  test('returns 401 with API key (sessionAuth only)', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .get('/api/history')
      .set('x-api-key', API_KEY)
      .expect(401);
  });

  test('LIST query orders by created_at DESC, npc.id DESC (tie-break)', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toMatch(/ORDER BY npc\.created_at DESC,\s*npc\.id DESC/);
  });

  test('returns calls and total count for authenticated caller', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test('caller role forced to own calls only (ignores caller param)', async () => {
    mockSession('ryann', 'caller');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=kate')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain('ryann');
    expect(dataParams).not.toContain('kate');
  });

  test('admin can see all calls (no caller filter applied)', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).not.toContain('tom');
  });

  test('admin can filter by specific caller', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=ryann')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain('ryann');
  });

  test('FTS search with q param triggers tsvector query', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?q=compressor')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('to_tsvector');
    expect(dataQuery).toContain('plainto_tsquery');
    expect(pool.query.mock.calls[0][1]).toContain('compressor');
  });

  test('disposition filter', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?disposition=connected')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain('connected');
  });

  test('qualification filter', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?qualification=hot')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('qualification');
    expect(pool.query.mock.calls[0][1]).toContain('hot');
  });

  test('date range from/to filters', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?from=2026-04-01T00:00:00Z&to=2026-04-10T23:59:59Z')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('created_at >=');
    expect(dataQuery).toContain('created_at <=');
  });

  test('hasSummary=true triggers EXISTS subquery', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?hasSummary=true')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('ai_summary IS NOT NULL');
    expect(dataQuery).toContain('EXISTS');
  });

  test('data query uses LATERAL JOIN on customer_interactions', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('LEFT JOIN LATERAL');
    expect(dataQuery).toContain('customer_interactions');
  });

  test('count query does NOT use LATERAL JOIN', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const countQuery = pool.query.mock.calls[1][0];
    expect(countQuery).toContain('COUNT(*)');
    expect(countQuery).not.toContain('LEFT JOIN LATERAL');
  });

  test('clamps limit to 1–200 range', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?limit=999')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain(200);
  });

  test('pagination with limit + offset', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?limit=10&offset=20')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain(20);
  });

  test('returns 500 on DB error', async () => {
    mockSession('ryann');
    pool.query.mockRejectedValueOnce(new Error('db error'));

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(500);
  });
});

/* ───────────── GET /api/history/:id ───────────── */

describe('GET /api/history/:id', () => {
  test('returns 401 without session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history/1').expect(401);
  });

  test('returns 400 for non-numeric id', async () => {
    mockSession('ryann');
    await request(app)
      .get('/api/history/abc')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(400);
  });

  test('returns 404 when call not found', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/999')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);
  });

  test('returns call detail with LATERAL JOIN for own call', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    const res = await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.id).toBe(1);
    const query = pool.query.mock.calls[0][0];
    expect(query).toContain('LEFT JOIN LATERAL');
  });

  test('non-admin cannot access other callers detail', async () => {
    mockSession('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('kate');
  });

  test('admin can access any call', async () => {
    mockSession('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    await request(app)
      .get('/api/history/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toEqual([1]);
  });
});

/* ───────────── GET /api/history/:id/timeline ───────────── */

describe('GET /api/history/:id/timeline', () => {
  test('returns 401 without session', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/history/1/timeline').expect(401);
  });

  test('returns 404 if parent call not found', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/999/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);
  });

  test('non-admin cannot access other callers timeline (404 gate)', async () => {
    mockSession('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/1/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);

    // Parent call query should filter by caller_identity
    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('kate');
    // lookupCustomer should NOT have been called because parent gate failed
    expect(lookupCustomer).not.toHaveBeenCalled();
  });

  test('returns interactions for owned call', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({
      rows: [{
        lead_phone: '+16025551234',
        lead_email: null,
        hubspot_contact_id: '101',
        lead_company: 'Acme',
        lead_name: 'Jane',
        conference_name: 'nucleus-call-abc',
      }],
      rowCount: 1,
    });
    lookupCustomer.mockResolvedValueOnce({
      interactions: [
        { sessionId: 'npc_other', channel: 'voice', summary: 'Prior call' },
        { sessionId: 'npc_nucleus-call-abc', channel: 'voice', summary: 'This call' },
      ],
    });

    const res = await request(app)
      .get('/api/history/1/timeline')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // Current call's own session_id should be excluded
    expect(res.body.interactions).toHaveLength(1);
    expect(res.body.interactions[0].sessionId).toBe('npc_other');
  });
});

/* ───────────── Bearer auth on GET routes ───────────── */

describe('Bearer auth on GET routes', () => {
  test('GET /api/history accepts Authorization: Bearer', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/history')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
  });

  test('GET /api/history bearer path enforces non-admin ownership filter', async () => {
    // Proof that bearer ran (not sessionAuth fallback): we send NO cookie,
    // and key jwt.verify so it ONLY succeeds for the bearer-token string.
    // If bearerOrSession's discriminator inverted, sessionAuth would receive
    // the request, find no cookie, and 401 — making this test fail at the
    // status assertion before the ownership-filter assertions ever run.
    const kateId = 8001;
    __testSetUser({
      id: kateId,
      email: 'kate@joruva.com',
      identity: 'kate',
      role: 'caller',
      displayName: 'kate',
    });
    jwt.verify.mockImplementation((token) => {
      if (token === 'kate-bearer') return { userId: kateId };
      throw new Error('unknown token');
    });
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=ryann')
      .set('Authorization', 'Bearer kate-bearer')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain('kate');
    expect(dataParams).not.toContain('ryann');
  });

  test('GET /api/history/:id accepts Bearer', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    await request(app)
      .get('/api/history/1')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);
  });

  test('GET /api/history/:id/timeline accepts Bearer', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({
      rows: [{
        lead_phone: '+16025551234',
        lead_email: null,
        hubspot_contact_id: '101',
        lead_company: 'Acme',
        lead_name: 'Jane',
        conference_name: 'nucleus-call-abc',
      }],
      rowCount: 1,
    });
    lookupCustomer.mockResolvedValueOnce({ interactions: [] });

    await request(app)
      .get('/api/history/1/timeline')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);
  });

  test('malformed Authorization header → 401', async () => {
    await request(app)
      .get('/api/history')
      .set('Authorization', 'NotBearer xyz')
      .expect(401);
  });

  test('Bearer with no token → 401', async () => {
    await request(app)
      .get('/api/history')
      .set('Authorization', 'Bearer ')
      .expect(401);
  });

  test('Bearer with invalid jwt → 401', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid jwt'); });
    await request(app)
      .get('/api/history')
      .set('Authorization', 'Bearer bad-jwt')
      .expect(401);
  });

  test('Bearer with token whose userId no longer maps to active user → 401', async () => {
    // jwt verify succeeds with a userId we explicitly evict from the cache,
    // and the DB query for that user returns no row (simulating deleted /
    // inactive user). The invalidateUser call is not optional defense — if a
    // future beforeEach pre-seeds the user cache, this test would silently go
    // green via a cache hit instead of exercising the DB-miss path.
    invalidateUser(999999);
    jwt.verify.mockReturnValue({ userId: 999999 });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/history')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(401);
  });

  test('Bearer GET succeeds without X-Requested-With', async () => {
    // sessionAuth's CSRF check is gated on `req.method !== 'GET' && !== 'HEAD'`,
    // so a session GET would also pass without the header — this test isn't
    // proving bearer is CSRF-immune in general, just that the header isn't a
    // hidden requirement on the bearer path either. (The dialer never sends
    // non-GET to history routes; if it ever does, add a parallel POST test.)
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Authorization', 'Bearer fake-jwt')
      // intentionally NO X-Requested-With
      .expect(200);
  });

  test('Bearer wins over cookie when both are present', async () => {
    // Register two distinct users — one resolved via cookie token, one via
    // bearer token — and key jwt.verify on the input. If the discriminator in
    // bearerOrSession was inverted (or removed), the wrong user's identity
    // would land in the ownership-filter params. This is the only assertion
    // that ACTUALLY proves bearer beat cookie — a single-user mockSession
    // would pass either way.
    const cookieUserId = 7001;
    const bearerUserId = 7002;
    __testSetUser({
      id: cookieUserId,
      email: 'cookie-user@joruva.com',
      identity: 'cookie-user',
      role: 'caller',
      displayName: 'cookie-user',
    });
    __testSetUser({
      id: bearerUserId,
      email: 'bearer-user@joruva.com',
      identity: 'bearer-user',
      role: 'caller',
      displayName: 'bearer-user',
    });
    jwt.verify.mockImplementation((token) => {
      if (token === 'bearer-token') return { userId: bearerUserId };
      if (token === 'cookie-token') return { userId: cookieUserId };
      throw new Error('unknown token');
    });
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('Cookie', 'nucleus_session=cookie-token')
      .set('Authorization', 'Bearer bearer-token')
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain('bearer-user');
    expect(dataParams).not.toContain('cookie-user');
  });
});

/* ───────────── POST /api/history/:id/disposition ───────────── */

describe('POST /api/history/:id/disposition', () => {
  test('returns 400 for non-numeric id', async () => {
    await request(app)
      .post('/api/history/abc/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(400);
  });

  test('returns 400 when disposition is missing', async () => {
    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ notes: 'good call' })
      .expect(400);
  });

  test('returns 404 when call not found', async () => {
    // Enriched re-fetch returns empty, initial UPDATE returns empty
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post('/api/history/999/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(404);
  });

  test('non-admin session user cannot modify other callers call (403)', async () => {
    mockSession('kate', 'caller');
    // Ownership check returns tom's call
    pool.query.mockResolvedValueOnce({
      rows: [{ caller_identity: 'tom' }],
      rowCount: 1,
    });

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({ disposition: 'connected' })
      .expect(403);
  });

  test('admin session user can modify any call', async () => {
    mockSession('tom', 'admin');
    // Ownership check SKIPPED for admin. Jumps straight to UPDATE.
    const updated = { ...SAMPLE_CALL, disposition: 'connected', caller_identity: 'ryann' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({ disposition: 'connected' })
      .expect(200);
  });

  test('API key caller skips ownership check (trusted automation)', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    // Should have called UPDATE first (no ownership SELECT)
    expect(pool.query.mock.calls[0][0]).toContain('UPDATE');
  });

  test('saves disposition and returns enriched call', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected', qualification: null };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })   // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });  // enriched re-fetch

    const res = await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    expect(res.body.disposition).toBe('connected');
  });

  test('enriched response query uses LATERAL JOIN', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    // Second query is the enriched re-fetch — should use LATERAL JOIN
    const enrichedQuery = pool.query.mock.calls[1][0];
    expect(enrichedQuery).toContain('LEFT JOIN LATERAL');
  });

  test('sends Slack alert for hot leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'qualified', qualification: 'hot' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // slack flag UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });   // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'qualified', qualification: 'hot', notes: 'ready to buy' })
      .expect(200);

    await flushFireAndForget();

    expect(formatCallAlert).toHaveBeenCalledWith(
      expect.objectContaining({ qualification: 'hot' })
    );
    expect(sendSlackAlert).toHaveBeenCalled();
  });

  test('does NOT send Slack alert for cold leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'not_interested', qualification: 'cold' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'not_interested', qualification: 'cold' })
      .expect(200);

    await flushFireAndForget();

    expect(sendSlackAlert).not.toHaveBeenCalled();
  });

  test('syncs note to HubSpot when contact id present', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })          // hubspot_synced UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });  // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected', notes: 'good chat' })
      .expect(200);

    await flushFireAndForget();

    expect(addNoteToContact).toHaveBeenCalledWith(
      '101',
      expect.stringContaining('Outbound call by ryann')
    );
  });

  test('does NOT sync to HubSpot when no contact id', async () => {
    const updated = { ...SAMPLE_CALL, hubspot_contact_id: null, disposition: 'voicemail' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'voicemail' })
      .expect(200);

    await flushFireAndForget();

    expect(addNoteToContact).not.toHaveBeenCalled();
  });

  test('syncs interaction to customer_interactions', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    await flushFireAndForget();

    expect(syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'voice',
        direction: 'outbound',
        phone: '+16025551234',
      })
    );
  });

  test('maps hot qualification to qualified_hot disposition in sync', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'qualified', qualification: 'hot' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })           // slack flag
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });   // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'qualified', qualification: 'hot' })
      .expect(200);

    await flushFireAndForget();

    expect(syncInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: 'qualified_hot',
        qualification: { stage: 'hot', score: 90 },
      })
    );
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(500);
  });

  // zht.7: POST disposition is now on bearerOrApiKeyOrSession — valid bearer
  // (iOS dialer) is accepted alongside the existing API-key (automation) and
  // session-cookie (web) paths.
  test('valid Bearer on POST is accepted (zht.7 three-way auth)', async () => {
    mockSession('ryann');
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [{ caller_identity: 'ryann' }], rowCount: 1 }) // ownership
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })                       // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });                      // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ disposition: 'connected' })
      .expect(200);
  });

  test('invalid Bearer on POST is rejected with 401', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .post('/api/history/1/disposition')
      .set('Authorization', 'Bearer some-token')
      .send({ disposition: 'connected' })
      .expect(401);
  });

  test('invalid Bearer with valid x-api-key: still 401 (no fallthrough on bearer failure)', async () => {
    // Belt-and-suspenders: bearerAuth 401s inline on bad JWT and does not
    // hand control back to the composer. A caller who sends a stale bearer
    // token cannot accidentally authenticate via the synthetic api-key
    // admin principal even if x-api-key is also valid. Locks the
    // no-fallthrough invariant the composer relies on.
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .post('/api/history/1/disposition')
      .set('Authorization', 'Bearer expired-jwt')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(401);
  });

  test('Bearer wins over x-api-key when both are present (composer precedence)', async () => {
    // Composer order: bearer → apiKey → session. If a request sends BOTH
    // a valid bearer JWT AND a valid x-api-key, bearer must win — the
    // resulting principal is the bearer user (not the synthetic api-key admin).
    // Proof: ownership check fires (req.user.role === 'caller'), so the call
    // row's caller_identity must equal the bearer user's identity to pass.
    const bearerUserId = 9001;
    __testSetUser({
      id: bearerUserId,
      email: 'composer-test@joruva.com',
      identity: 'composer-test',
      role: 'caller',
      displayName: 'composer-test',
    });
    jwt.verify.mockReturnValue({ userId: bearerUserId });
    const updated = { ...SAMPLE_CALL, caller_identity: 'composer-test', disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [{ caller_identity: 'composer-test' }], rowCount: 1 }) // ownership
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })                              // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });                             // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('Authorization', 'Bearer fake-jwt')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    // If api-key had won, req.user.role would be 'admin' — bypassing the
    // ownership check entirely. Bearer winning means caller-role ownership
    // ran, and 'composer-test' === SAMPLE_CALL.caller_identity check passed.
  });

  // The disposition UPDATE param order is [disposition, qualification, notes,
  // products_discussed, lead_email, id]. These tests pin the lead_email slot
  // by index from the END of the array (id is always last) so adding a column
  // to the UPDATE later doesn't silently break this coupling.
  const leadEmailParam = (call) => call[1].at(-2);

  // Count pool.query calls that wrote the lead_email column. Both UPDATEs
  // that touch it (main UPDATE via COALESCE, follow-up block's standalone
  // SET lead_email = $1) match this regex; no other column in the table
  // contains the substring `lead_email`.
  const leadEmailWriteCount = (calls) =>
    calls.filter(([sql]) => /SET[\s\S]*lead_email/.test(sql)).length;

  // Persist a valid lead_email even when the rep doesn't trigger a follow-up.
  // Locks the captured-but-unused-this-call address so the next session
  // (or another rep) sees it pre-filled instead of having to re-collect it.
  test('persists valid lead_email on UPDATE even when send_follow_up=false', async () => {
    const updated = {
      ...SAMPLE_CALL,
      disposition: 'connected',
      lead_email: 'jane@acme.com',
    };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 }); // enriched re-fetch

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({
        disposition: 'connected',
        lead_email: 'jane@acme.com',
        send_follow_up: false,
      })
      .expect(200);

    expect(leadEmailParam(pool.query.mock.calls[0])).toBe('jane@acme.com');
  });

  // Garbage in body must not clobber a previously-saved address. The COALESCE
  // pattern only writes when our validated parameter is non-null, so an
  // invalid input arrives at the DB as NULL and is short-circuited.
  test('drops malformed lead_email instead of overwriting saved column', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected', lead_email: 'not-an-email' })
      .expect(200);

    expect(leadEmailParam(pool.query.mock.calls[0])).toBeNull();
  });

  // Pre-existing bug surfaced by the bd-uqp fix: the email-trigger block
  // used the RAW body lead_email for its !resolvedEmail short-circuit, so
  // a garbage value like "asdf" passed the truthy check and blocked the
  // HubSpot fallback entirely. Follow-up never sent even when HubSpot had
  // a valid address. Fix: use validatedLeadEmail (null for invalid input)
  // so the short-circuit reaches the fallback path. Without the fix, this
  // test fails because getContact is never called.
  test('garbage lead_email does not block HubSpot fallback in send_follow_up path', async () => {
    mockSession('tom', 'admin');
    const updated = {
      ...SAMPLE_CALL,
      disposition: 'connected',
      hubspot_contact_id: '101',
      follow_up_email_sent: false,
    };

    pool.query.mockResolvedValue({ rows: [updated], rowCount: 1 });
    getContact.mockResolvedValueOnce({ properties: { email: 'jane@acme.com' } });

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({
        disposition: 'connected',
        lead_email: 'asdf',         // garbage in body
        send_follow_up: true,
      })
      .expect(200);

    await flushFireAndForget();

    expect(getContact).toHaveBeenCalledWith('101');
    expect(sendFollowUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'jane@acme.com' })
    );
  });

  // Anything past the RFC 5321 254-char limit is rejected before the regex
  // ever sees it — both as a defense against unbounded user input on every
  // disposition and as a sanity gate (a 10KB string with an `@` would
  // otherwise pass shape validation).
  test('rejects lead_email longer than 254 chars (RFC 5321 cap)', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected' };
    pool.query
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const longLocal = 'a'.repeat(250);
    const oversize = `${longLocal}@b.co`; // 257 chars — passes EMAIL_RE shape

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected', lead_email: oversize })
      .expect(200);

    expect(leadEmailParam(pool.query.mock.calls[0])).toBeNull();
  });

  // bd-t8jo, common path: rep typed a valid email + ticked send_follow_up.
  // Main UPDATE writes lead_email via COALESCE. Without the guard, the
  // follow-up block would write the same value again — two round-trips, same
  // result. With the guard, only the main UPDATE touches lead_email.
  test('common path issues exactly one lead_email write (bd-t8jo)', async () => {
    mockSession('tom', 'admin');
    const updated = {
      ...SAMPLE_CALL,
      disposition: 'connected',
      lead_email: 'jane@acme.com',  // post-UPDATE state matches body
      hubspot_contact_id: null,      // skip HubSpot sync to keep mock chain clean
      follow_up_email_sent: false,
    };

    pool.query.mockResolvedValue({ rows: [updated], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({
        disposition: 'connected',
        lead_email: 'jane@acme.com',
        send_follow_up: true,
      })
      .expect(200);

    await flushFireAndForget();

    expect(leadEmailWriteCount(pool.query.mock.calls)).toBe(1);
    expect(sendFollowUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'jane@acme.com' })
    );
  });

  // bd-t8jo, HubSpot fallback path: body has no lead_email, contact provides
  // one. Main UPDATE preserves the existing column (COALESCE($null, ...)) so
  // no body-driven write happens; the follow-up block's UPDATE is the ONLY
  // place the resolved address gets persisted. Without that write, the
  // address is sent but not saved — next call to the same lead loses it.
  test('HubSpot fallback path persists lead_email exactly once (bd-t8jo)', async () => {
    mockSession('tom', 'admin');
    const updatedBeforeWrite = {
      ...SAMPLE_CALL,
      disposition: 'connected',
      lead_email: null,              // nothing saved yet
      hubspot_contact_id: '101',
      follow_up_email_sent: false,
    };

    pool.query.mockResolvedValue({ rows: [updatedBeforeWrite], rowCount: 1 });
    getContact.mockResolvedValueOnce({ properties: { email: 'jane@acme.com' } });

    await request(app)
      .post('/api/history/1/disposition')
      .set('Cookie', 'nucleus_session=fake-token')
      .set('X-Requested-With', 'fetch')
      .send({ disposition: 'connected', send_follow_up: true })
      .expect(200);

    await flushFireAndForget();

    // Main UPDATE writes (COALESCE preserves null → null), follow-up block
    // writes the resolved address. Both queries match the regex, so total = 2.
    // Without the email-trigger UPDATE, the resolved address would be sent
    // but not saved.
    const writes = pool.query.mock.calls.filter(([sql]) =>
      /SET[\s\S]*lead_email/.test(sql)
    );
    expect(writes).toHaveLength(2);
    // The follow-up UPDATE is the one that carries the resolved address as $1.
    const followUpWrite = writes.find(([sql]) => /^UPDATE.*SET lead_email = \$1/i.test(sql));
    expect(followUpWrite[1][0]).toBe('jane@acme.com');
    expect(sendFollowUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'jane@acme.com' })
    );
  });
});
