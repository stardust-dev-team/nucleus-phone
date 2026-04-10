jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

// Mock jsonwebtoken so sessionAuth succeeds without real secrets
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');

const SAMPLE_SUMMARY = {
  id: 1,
  created_at: '2026-03-25T10:00:00Z',
  caller_identity: 'ryann',
  lead_name: 'Jane Doe',
  lead_company: 'Acme Corp',
  lead_phone: '+16025551234',
  duration_seconds: 342,
  disposition: 'connected',
  qualification: 'warm',
  ai_summary: 'Discussed JRS-10E pricing and delivery.',
  ai_action_items: { action_items: ['Send quote'], next_step: 'Follow up Friday' },
  notes: 'Good call, interested in 10HP unit.',
  products_discussed: ['JRS-10E'],
  recording_url: 'https://api.twilio.com/recording/123',
  conference_name: 'nucleus-call-abc',
  ci_summary: null,
  ci_products: null,
  sentiment: null,
  competitive_intel: null,
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/summaries', require('../summaries'));
  return app;
}

function mockSession(identity, role = 'caller') {
  jwt.verify.mockReturnValue({ identity, role, email: `${identity}@joruva.com` });
}

let app;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  app = makeApp();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── GET /api/summaries ───────────── */

describe('GET /api/summaries', () => {
  test('returns 401 without session cookie', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app).get('/api/summaries').expect(401);
  });

  test('returns 401 with API key (sessionAuth only)', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid'); });
    await request(app)
      .get('/api/summaries')
      .set('x-api-key', 'some-key')
      .expect(401);
  });

  test('returns summaries for authenticated caller', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_SUMMARY], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/summaries')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.summaries).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test('caller role forced to own calls only (ignores caller param)', async () => {
    mockSession('ryann', 'caller');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/summaries?caller=tom')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // Should filter by ryann, NOT tom
    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('caller_identity');
    expect(pool.query.mock.calls[0][1]).toContain('ryann');
    expect(pool.query.mock.calls[0][1]).not.toContain('tom');
  });

  test('admin can see all calls', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_SUMMARY], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    await request(app)
      .get('/api/summaries')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // No caller_identity filter when admin doesn't pass caller param
    const dataQuery = pool.query.mock.calls[0][0];
    expect(pool.query.mock.calls[0][1]).not.toContain('tom');
  });

  test('admin can filter by specific caller', async () => {
    mockSession('tom', 'admin');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/summaries?caller=ryann')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(pool.query.mock.calls[0][1]).toContain('ryann');
  });

  test('search query triggers full-text search', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/summaries?q=compressor')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('to_tsvector');
    expect(dataQuery).toContain('plainto_tsquery');
    expect(pool.query.mock.calls[0][1]).toContain('compressor');
  });

  test('pagination works', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '50' }], rowCount: 1 });

    await request(app)
      .get('/api/summaries?limit=10&offset=20')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain(10);  // limit
    expect(params).toContain(20);  // offset
  });

  test('empty results', async () => {
    mockSession('ryann');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/summaries')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.summaries).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('returns 500 on DB error', async () => {
    mockSession('ryann');
    pool.query.mockRejectedValueOnce(new Error('db error'));

    await request(app)
      .get('/api/summaries')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(500);
  });
});

/* ───────────── GET /api/summaries/:id ───────────── */

describe('GET /api/summaries/:id', () => {
  test('returns 400 for non-numeric id', async () => {
    mockSession('ryann');
    await request(app)
      .get('/api/summaries/abc')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(400);
  });

  test('returns 404 when not found', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/summaries/999')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);
  });

  test('returns detail for own call', async () => {
    mockSession('ryann');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_SUMMARY], rowCount: 1 });

    const res = await request(app)
      .get('/api/summaries/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.id).toBe(1);
    expect(res.body.ai_summary).toContain('JRS-10E');
  });

  test('non-admin cannot access other callers calls', async () => {
    mockSession('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/summaries/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(404);

    // Should have caller_identity filter
    const query = pool.query.mock.calls[0][0];
    expect(query).toContain('caller_identity');
    expect(pool.query.mock.calls[0][1]).toContain('kate');
  });

  test('admin can access any call', async () => {
    mockSession('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_SUMMARY], rowCount: 1 });

    const res = await request(app)
      .get('/api/summaries/1')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // Should NOT have caller_identity filter
    const query = pool.query.mock.calls[0][0];
    expect(pool.query.mock.calls[0][1]).toEqual([1]);
  });
});
