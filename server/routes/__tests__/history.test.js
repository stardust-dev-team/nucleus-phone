// Flush microtask queue so fire-and-forget .then()/.catch() chains settle.
// Works because history.js chains have no intermediate awaits. If that changes,
// increase the flush count here — single point of fix.
const flushFireAndForget = () => new Promise((r) => setImmediate(r));

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  formatCallAlert: jest.fn().mockReturnValue({ text: 'mock alert' }),
}));
jest.mock('../../lib/hubspot', () => ({
  addNoteToContact: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../lib/interaction-sync', () => ({
  syncInteraction: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../lib/format', () => ({
  formatDuration: jest.fn().mockReturnValue('5m 42s'),
}));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { sendSlackAlert, formatCallAlert } = require('../../lib/slack');
const { addNoteToContact } = require('../../lib/hubspot');
const { syncInteraction } = require('../../lib/interaction-sync');

const API_KEY = 'test-api-key';

const SAMPLE_CALL = {
  id: 1,
  created_at: '2026-03-25T10:00:00Z',
  conference_name: 'nucleus-call-abc',
  caller_identity: 'tom',
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
};

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  app.use('/api/history', require('../history'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── GET /api/history ───────────── */

describe('GET /api/history', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/history').expect(401);
  });

  test('returns calls and total count', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

    const res = await request(app)
      .get('/api/history')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });

  test('filters by caller', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=kate')
      .set('x-api-key', API_KEY)
      .expect(200);

    // First query (data) should include caller_identity filter
    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('caller_identity');
    expect(pool.query.mock.calls[0][1]).toContain('kate');
  });

  test('filters by disposition', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?disposition=connected')
      .set('x-api-key', API_KEY)
      .expect(200);

    const dataQuery = pool.query.mock.calls[0][0];
    expect(dataQuery).toContain('disposition');
    expect(pool.query.mock.calls[0][1]).toContain('connected');
  });

  test('applies combined filters', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?caller=tom&disposition=hot')
      .set('x-api-key', API_KEY)
      .expect(200);

    const params = pool.query.mock.calls[0][1];
    expect(params).toContain('tom');
    expect(params).toContain('hot');
  });

  test('clamps limit to 1–200 range', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history?limit=999')
      .set('x-api-key', API_KEY)
      .expect(200);

    // The limit param should be clamped to 200
    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain(200);
  });

  test('defaults limit to 25', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    await request(app)
      .get('/api/history')
      .set('x-api-key', API_KEY)
      .expect(200);

    const dataParams = pool.query.mock.calls[0][1];
    expect(dataParams).toContain(25);
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('db error'));

    await request(app)
      .get('/api/history')
      .set('x-api-key', API_KEY)
      .expect(500);
  });
});

/* ───────────── GET /api/history/:id ───────────── */

describe('GET /api/history/:id', () => {
  test('returns 400 for non-numeric id', async () => {
    await request(app)
      .get('/api/history/abc')
      .set('x-api-key', API_KEY)
      .expect(400);
  });

  test('returns 404 when call not found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/history/999')
      .set('x-api-key', API_KEY)
      .expect(404);
  });

  test('returns call detail', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_CALL], rowCount: 1 });

    const res = await request(app)
      .get('/api/history/1')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.id).toBe(1);
    expect(res.body.caller_identity).toBe('tom');
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
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post('/api/history/999/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(404);
  });

  test('saves disposition and returns updated call', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'connected', qualification: null };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected' })
      .expect(200);

    expect(res.body.disposition).toBe('connected');
    // Param order mirrors SET clause: disposition, qualification, notes, products_discussed, id
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE nucleus_phone_calls'),
      ['connected', null, null, '[]', 1]
    );
  });

  test('sends Slack alert for hot leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'qualified', qualification: 'hot' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    // slack_notified UPDATE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

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

  test('sends Slack alert for warm leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'callback_requested', qualification: 'warm' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'callback_requested', qualification: 'warm' })
      .expect(200);

    await flushFireAndForget();

    expect(sendSlackAlert).toHaveBeenCalled();
  });

  test('does NOT send Slack alert for cold leads', async () => {
    const updated = { ...SAMPLE_CALL, disposition: 'not_interested', qualification: 'cold' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

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
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    // hubspot_synced UPDATE
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app)
      .post('/api/history/1/disposition')
      .set('x-api-key', API_KEY)
      .send({ disposition: 'connected', notes: 'good chat' })
      .expect(200);

    await flushFireAndForget();

    expect(addNoteToContact).toHaveBeenCalledWith(
      '101',
      expect.stringContaining('Outbound call by tom')
    );
  });

  test('does NOT sync to HubSpot when no contact id', async () => {
    const updated = { ...SAMPLE_CALL, hubspot_contact_id: null, disposition: 'voicemail' };
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

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
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

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
    pool.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // slack flag

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
});
