jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../config/team.json', () => ({
  members: [
    { identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' },
    { identity: 'paul', name: 'Paul', email: 'paul@joruva.com', role: 'admin' },
  ],
}));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue({}),
}));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { sendSlackAlert } = require('../../lib/slack');

const API_KEY = 'test-api-key';

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  app = express();
  app.use(express.json());
  app.use('/api/scoreboard', require('../scoreboard'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
});

describe('GET /api/scoreboard', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/scoreboard').expect(401);
  });

  test('returns leaderboard shape', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          caller_identity: 'tom',
          calls_made: '15',
          leads_qualified: '3',
          hot_leads: '1',
          callbacks: '2',
          avg_duration: 180,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          caller_identity: 'tom',
          day: '2026-03-27',
          calls: '5',
        }],
        rowCount: 1,
      });

    const res = await request(app)
      .get('/api/scoreboard')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.period).toBe('7d');
    expect(res.body.leaderboard).toHaveLength(1);
    const entry = res.body.leaderboard[0];
    expect(entry.displayName).toBe('Tom');
    expect(entry.callsMade).toBe(15);
    expect(entry.daily).toHaveLength(1);
  });
});

describe('POST /api/scoreboard/aggregate', () => {
  test('returns 401 without auth', async () => {
    await request(app).post('/api/scoreboard/aggregate').expect(401);
  });

  test('aggregates and returns row count', async () => {
    // Aggregation upsert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 3 });

    const res = await request(app)
      .post('/api/scoreboard/aggregate')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.aggregated).toBe(3);
  });

  test('triggers milestone check (fire-and-forget)', async () => {
    // Aggregation upsert
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // Milestone init (INSERT ON CONFLICT DO NOTHING)
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // First qualified lead query
    pool.query.mockResolvedValueOnce({
      rows: [{ agent_name: 'tom', total: 1 }],
      rowCount: 1,
    });
    // Streaks query
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // claimMilestone UPDATE — won
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // pruneMilestoneKeys
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .post('/api/scoreboard/aggregate')
      .set('x-api-key', API_KEY)
      .expect(200);

    // checkMilestones is fire-and-forget — flush microtasks
    await new Promise(resolve => setImmediate(resolve));

    expect(sendSlackAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Tom'),
      })
    );
  });

  test('milestone already claimed — no Slack alert', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // aggregation
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // milestone init
    pool.query.mockResolvedValueOnce({                            // first_qual candidate
      rows: [{ agent_name: 'tom', total: 1 }],
      rowCount: 1,
    });
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // streaks
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // claimMilestone — NOT won

    await request(app)
      .post('/api/scoreboard/aggregate')
      .set('x-api-key', API_KEY)
      .expect(200);

    await new Promise(resolve => setImmediate(resolve));

    expect(sendSlackAlert).not.toHaveBeenCalled();
  });
});
