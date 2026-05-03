jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/hubspot', () => ({
  searchContacts: jest.fn(),
  getContact: jest.fn(),
  findContactByPhone: jest.fn(),
}));
jest.mock('jsonwebtoken');

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const hubspot = require('../../lib/hubspot');
const { __testSetUser } = require('../../middleware/auth');

const API_KEY = 'test-api-key';

let nextUserId = 3000;
function mockSession(identity = 'tom', role = 'admin') {
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
  app.use('/api/contacts', require('../contacts'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  // Defense-in-depth: jwt.verify throws by default so an API-key test that
  // accidentally sends a cookie header can't coast on a stale mockSession.
  jwt.verify.mockImplementation(() => { throw new Error('no session'); });
});

/* ───────────── GET /api/contacts ───────────── */

describe('GET /api/contacts', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/contacts').expect(401);
  });

  test('returns contacts from HubSpot with no call history', async () => {
    hubspot.searchContacts.mockResolvedValue({
      results: [
        { id: '101', properties: { firstname: 'Jane', phone: '+16025551111' } },
      ],
      paging: null,
    });

    const res = await request(app)
      .get('/api/contacts')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].callHistory).toBeNull();
    expect(res.body.paging).toBeNull();
  });

  test('passes query, limit, and after to HubSpot', async () => {
    hubspot.searchContacts.mockResolvedValue({ results: [], paging: null });

    await request(app)
      .get('/api/contacts?q=acme&limit=10&after=abc123')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(hubspot.searchContacts).toHaveBeenCalledWith('acme', 10, 'abc123');
  });

  test('session auth: enriches contacts with full call history including lastSummary', async () => {
    mockSession();
    hubspot.searchContacts.mockResolvedValue({
      results: [
        { id: '101', properties: { firstname: 'Jane', phone: '+16025551111' } },
        { id: '102', properties: { firstname: 'Bob', mobilephone: '+16025552222' } },
      ],
      paging: { next: { after: 'cursor2' } },
    });

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          lead_phone: '+16025551111',
          hubspot_contact_id: '101',
          call_count: '3',
          last_call: '2026-03-25T10:00:00Z',
          last_disposition: 'callback_requested',
          last_summary: 'Wants quote by Friday, concerned about JDD-40 downtime',
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/contacts?q=test')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    expect(res.body.contacts[0].callHistory).toEqual({
      callCount: 3,
      lastCall: '2026-03-25T10:00:00Z',
      lastDisposition: 'callback_requested',
      lastSummary: 'Wants quote by Friday, concerned about JDD-40 downtime',
    });
    expect(res.body.contacts[1].callHistory).toBeNull();
    expect(res.body.paging).toEqual({ next: { after: 'cursor2' } });
  });

  test('api key auth: call history does NOT expose lastSummary', async () => {
    hubspot.searchContacts.mockResolvedValue({
      results: [
        { id: '101', properties: { firstname: 'Jane', phone: '+16025551111' } },
      ],
      paging: null,
    });

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          lead_phone: '+16025551111',
          hubspot_contact_id: '101',
          call_count: '3',
          last_call: '2026-03-25T10:00:00Z',
          last_disposition: 'callback_requested',
          last_summary: 'Wants quote by Friday, concerned about JDD-40 downtime',
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/contacts?q=test')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.contacts[0].callHistory).toEqual({
      callCount: 3,
      lastCall: '2026-03-25T10:00:00Z',
      lastDisposition: 'callback_requested',
    });
    expect(res.body.contacts[0].callHistory.lastSummary).toBeUndefined();
  });

  test('regression: NULL ai_summary on latest call maps to null (not stale older summary)', async () => {
    mockSession();
    hubspot.searchContacts.mockResolvedValue({
      results: [
        { id: '101', properties: { firstname: 'Jane', phone: '+16025551111' } },
      ],
      paging: null,
    });

    // Simulates the SQL output AFTER the COALESCE fix: the most recent call
    // is not yet summarized (Fireflies hasn't synced), so array_agg picks up
    // the COALESCE'd empty string from the latest row. The route maps '' → null.
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          lead_phone: '+16025551111',
          hubspot_contact_id: '101',
          call_count: '2',
          last_call: '2026-04-11T09:00:00Z', // today
          last_disposition: 'connected',
          last_summary: '', // COALESCE sentinel for NULL
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/contacts?q=test')
      .set('Cookie', 'nucleus_session=fake-token')
      .expect(200);

    // Key assertion: lastSummary is null, not inherited from an older call.
    expect(res.body.contacts[0].callHistory.lastSummary).toBeNull();
    expect(res.body.contacts[0].callHistory.lastCall).toBe('2026-04-11T09:00:00Z');
  });

  test('passes default limit of 50 when no limit param provided', async () => {
    hubspot.searchContacts.mockResolvedValue({ results: [], paging: null });

    await request(app)
      .get('/api/contacts?q=test')
      .set('x-api-key', API_KEY)
      .expect(200);

    const args = hubspot.searchContacts.mock.calls[0];
    expect(args[0]).toBe('test');
    expect(args[1]).toBe(50);
    expect(args[2]).toBeUndefined();
  });

  test('returns empty array when HubSpot returns no results', async () => {
    hubspot.searchContacts.mockResolvedValue({ results: [] });

    const res = await request(app)
      .get('/api/contacts')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.contacts).toEqual([]);
    // Should not query DB when there are no contacts to enrich
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns 500 on HubSpot error', async () => {
    hubspot.searchContacts.mockRejectedValue(new Error('HubSpot timeout'));

    const res = await request(app)
      .get('/api/contacts')
      .set('x-api-key', API_KEY)
      .expect(500);

    expect(res.body.error).toMatch(/Failed to fetch contacts/);
  });
});

/* ───────────── GET /api/contacts/:id ───────────── */

describe('GET /api/contacts/:id', () => {
  test('returns 400 for non-numeric id', async () => {
    await request(app)
      .get('/api/contacts/abc')
      .set('x-api-key', API_KEY)
      .expect(400);
  });

  test('returns contact with call history', async () => {
    hubspot.getContact.mockResolvedValue({
      id: '101',
      properties: { firstname: 'Jane', phone: '+16025551111' },
    });

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, created_at: '2026-03-20', caller_identity: 'tom', disposition: 'connected' },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/contacts/101')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.id).toBe('101');
    expect(res.body.callHistory).toHaveLength(1);
    expect(res.body.callHistory[0].caller_identity).toBe('tom');
  });

  test('queries DB with contact phone for history', async () => {
    hubspot.getContact.mockResolvedValue({
      id: '101',
      properties: { phone: '+16025559999' },
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/contacts/101')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('hubspot_contact_id'),
      ['101', '+16025559999']
    );
  });

  test('returns 500 on HubSpot error', async () => {
    hubspot.getContact.mockRejectedValue(new Error('not found'));

    await request(app)
      .get('/api/contacts/999')
      .set('x-api-key', API_KEY)
      .expect(500);
  });
});

/* ───────────── GET /api/contacts/lookup ───────────── */

// Tests use unique phone numbers per case so the module-level 5s cache from
// one test can't bleed into another. Cache key is the normalized phone, so
// US 11-digit (+1XXXXXXXXXX) and bare 10-digit (XXXXXXXXXX) collapse to the
// same entry — see the "cache key collapses equivalent formats" test.
describe('GET /api/contacts/lookup', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/contacts/lookup?phone=%2B16025550001').expect(401);
  });

  test('returns 400 when phone query param is missing', async () => {
    const res = await request(app)
      .get('/api/contacts/lookup')
      .set('x-api-key', API_KEY)
      .expect(400);
    expect(res.body.error).toMatch(/phone query param required/);
  });

  test('returns 400 when phone normalizes to null (too short)', async () => {
    const res = await request(app)
      .get('/api/contacts/lookup?phone=123')
      .set('x-api-key', API_KEY)
      .expect(400);
    expect(res.body.error).toMatch(/valid E\.164/);
  });

  test('returns projected contact on hit', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '12345',
      properties: { firstname: 'Tom', lastname: 'Russo', company: 'Acme' },
    });

    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550002')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ name: 'Tom Russo', company: 'Acme', hubspotId: '12345' });
  });

  test('returns all-null fields on miss (no HubSpot match)', async () => {
    hubspot.findContactByPhone.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550003')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ name: null, company: null, hubspotId: null });
  });

  test('partial name: only firstname → renders firstname alone', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '201',
      properties: { firstname: 'Tom', lastname: '', company: 'Acme' },
    });

    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550004')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ name: 'Tom', company: 'Acme', hubspotId: '201' });
  });

  test('partial name: only lastname → renders lastname alone', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '202',
      properties: { firstname: null, lastname: 'Russo', company: null },
    });

    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550005')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ name: 'Russo', company: null, hubspotId: '202' });
  });

  test('both names blank → name is null (company NOT folded into name)', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '203',
      properties: { firstname: '', lastname: null, company: 'Acme' },
    });

    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550006')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toEqual({ name: null, company: 'Acme', hubspotId: '203' });
  });

  test('cache hit: second call within 5s does NOT re-query HubSpot', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '301',
      properties: { firstname: 'Cached', lastname: 'Hit', company: 'Co' },
    });

    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550007')
      .set('x-api-key', API_KEY)
      .expect(200);
    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550007')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(hubspot.findContactByPhone).toHaveBeenCalledTimes(1);
  });

  test('cache key collapses equivalent formats (E.164 vs bare 10-digit)', async () => {
    hubspot.findContactByPhone.mockResolvedValue({
      id: '302',
      properties: { firstname: 'Same', lastname: 'Number', company: null },
    });

    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550008')
      .set('x-api-key', API_KEY)
      .expect(200);
    await request(app)
      .get('/api/contacts/lookup?phone=6025550008')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(hubspot.findContactByPhone).toHaveBeenCalledTimes(1);
  });

  test('miss is also cached: repeat lookup of unknown number does not re-hit HubSpot', async () => {
    hubspot.findContactByPhone.mockResolvedValue(null);

    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550009')
      .set('x-api-key', API_KEY)
      .expect(200);
    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550009')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(hubspot.findContactByPhone).toHaveBeenCalledTimes(1);
  });

  test('returns 500 on HubSpot failure (and does NOT cache the error)', async () => {
    hubspot.findContactByPhone
      .mockRejectedValueOnce(new Error('HubSpot timeout'))
      .mockResolvedValueOnce({
        id: '401',
        properties: { firstname: 'Recovered', lastname: 'Call', company: null },
      });

    await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550010')
      .set('x-api-key', API_KEY)
      .expect(500);

    // Second call must retry HubSpot, proving the error path didn't poison the cache.
    const res = await request(app)
      .get('/api/contacts/lookup?phone=%2B16025550010')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.name).toBe('Recovered Call');
    expect(hubspot.findContactByPhone).toHaveBeenCalledTimes(2);
  });
});
