jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/identity-resolver', () => ({
  resolve: jest.fn(),
}));
jest.mock('../../lib/customer-lookup', () => ({
  lookupCustomer: jest.fn().mockResolvedValue({ interactions: [] }),
}));
jest.mock('../../lib/hubspot', () => ({
  getCompany: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../lib/claude', () => ({
  generateRapportIntel: jest.fn().mockResolvedValue({ rapport_starters: [], fallback: true }),
  clearCache: jest.fn(),
}));
jest.mock('../../lib/phone', () => ({
  normalizePhone: jest.fn((p) => p),
}));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { resolve } = require('../../lib/identity-resolver');
const { lookupCustomer } = require('../../lib/customer-lookup');
const { getCompany } = require('../../lib/hubspot');
const { generateRapportIntel, clearCache } = require('../../lib/claude');

const API_KEY = 'test-api-key';

const MOCK_IDENTITY = {
  resolved: true,
  hubspotContactId: '101',
  hubspotCompanyId: 'C1',
  name: 'Jane Doe',
  email: 'jane@acme.com',
  phone: '+16025551234',
  company: 'Acme Corp',
  source: 'hubspot',
};

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  app.use('/api/cockpit', require('../cockpit'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  resolve.mockResolvedValue(MOCK_IDENTITY);
  lookupCustomer.mockResolvedValue({ interactions: [] });
  getCompany.mockResolvedValue(null);
  generateRapportIntel.mockResolvedValue({ rapport_starters: ['test'], fallback: false });
});

/* ───────────── GET /api/cockpit/:identifier ───────────── */

describe('GET /api/cockpit/:identifier', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/cockpit/+16025551234').expect(401);
  });

  test('returns mock data for test-call identifier', async () => {
    const res = await request(app)
      .get('/api/cockpit/test-call')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.identity.name).toBe('Mike Garza');
    expect(res.body.identity.hubspotContactId).toBe('test-call');
    // Should NOT call resolve or any external APIs
    expect(resolve).not.toHaveBeenCalled();
    expect(lookupCustomer).not.toHaveBeenCalled();
    expect(generateRapportIntel).not.toHaveBeenCalled();
  });

  test('resolves identity and assembles full cockpit', async () => {
    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(resolve).toHaveBeenCalledWith('+16025551234');
    expect(res.body.identity).toMatchObject({ name: 'Jane Doe' });
    expect(res.body.rapport).toBeDefined();
    expect(res.body.interactionHistory).toBeDefined();
    expect(res.body.priorCalls).toBeDefined();
    expect(res.body.pipelineData).toBeDefined();
    expect(res.body.icpScore).toBeDefined();
    expect(res.body.qaIntel).toBeDefined();
    expect(res.body.emailEngagement).toBeDefined();
    expect(res.body.companyData).toBeDefined();
  });

  test('assembles data from all sources (DB, HubSpot, UCIL)', async () => {
    getCompany.mockResolvedValue({ properties: { name: 'Acme', industry: 'Mfg' } });

    pool.query
      // Prior calls
      .mockResolvedValueOnce({
        rows: [{ id: 1, caller_identity: 'tom', disposition: 'connected' }],
        rowCount: 1,
      })
      // Discovery pipeline
      .mockResolvedValueOnce({
        rows: [{ domain: 'acme.com', company_name: 'Acme Corp', segment: 'cnc' }],
        rowCount: 1,
      })
      // ICP score
      .mockResolvedValueOnce({
        rows: [{ fit_score: '88', fit_reason: 'good fit' }],
        rowCount: 1,
      })
      // QA results
      .mockResolvedValueOnce({
        rows: [{ validation_status: 'valid' }],
        rowCount: 1,
      })
      // Email engagement
      .mockResolvedValueOnce({
        rows: [{ event_type: 'open', campaign_name: 'Test' }],
        rowCount: 1,
      });

    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.priorCalls).toHaveLength(1);
    expect(res.body.pipelineData).toHaveLength(1);
    expect(res.body.icpScore).toMatchObject({ fit_score: '88' });
    expect(res.body.companyData).toMatchObject({ name: 'Acme' });
    expect(lookupCustomer).toHaveBeenCalled();
    expect(generateRapportIntel).toHaveBeenCalled();
  });

  test('returns fallback data when all downstream sources fail', async () => {
    lookupCustomer.mockRejectedValueOnce(new Error('UCIL down'));
    // Persistent mock (not *Once) — route handler calls pool.query N times;
    // beforeEach resets via clearAllMocks + mockResolvedValue on next test.
    pool.query.mockImplementation(() => Promise.reject(new Error('connection lost')));
    getCompany.mockRejectedValueOnce(new Error('HubSpot 500'));

    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    // Should still return a response with null/empty fallbacks
    expect(res.body.identity).toBeDefined();
    expect(res.body.rapport).toBeDefined();
    expect(res.body.interactionHistory).toBeNull();
    expect(res.body.priorCalls).toEqual([]);
    expect(res.body.companyData).toBeNull();
  });

  test('clears cache when refresh=true', async () => {
    await request(app)
      .get('/api/cockpit/+16025551234?refresh=true')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(clearCache).toHaveBeenCalled();
  });

  test('does NOT clear cache when refresh is absent', async () => {
    await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(clearCache).not.toHaveBeenCalled();
  });

  test('skips optional queries when identity has no email/company', async () => {
    resolve.mockResolvedValue({
      ...MOCK_IDENTITY,
      email: null,
      company: null,
      hubspotCompanyId: null,
    });

    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    // No email → qaIntel and emailEngagement should be null/empty
    expect(res.body.qaIntel).toBeNull();
    expect(res.body.emailEngagement).toEqual([]);
    // No company → pipelineData and icpScore should be empty/null
    expect(res.body.pipelineData).toEqual([]);
    expect(res.body.icpScore).toBeNull();
    // No hubspotCompanyId → companyData should be null
    expect(res.body.companyData).toBeNull();
  });

  test('returns 500 when Claude rapport generation fails', async () => {
    generateRapportIntel.mockRejectedValue(new Error('Claude overloaded'));

    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(500);

    expect(res.body.error).toMatch(/Failed to assemble cockpit/);
  });

  test('returns 500 when identity resolution fails', async () => {
    resolve.mockRejectedValue(new Error('Apollo rate limit'));

    const res = await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(500);

    expect(res.body.error).toMatch(/Failed to assemble cockpit/);
  });

  test('passes assembled data to Claude for rapport generation', async () => {
    await request(app)
      .get('/api/cockpit/+16025551234')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(generateRapportIntel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jane Doe',
        interactionHistory: expect.anything(),
        priorCalls: expect.anything(),
      })
    );
  });
});
