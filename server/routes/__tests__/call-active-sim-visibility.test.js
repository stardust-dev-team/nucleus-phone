// Sim-visibility extension of GET /api/call/active (M3 Phase B2a).
// Admins see all in-progress + scoring sims; non-admin reps see their own
// in-progress sims only. This is what makes iOS's `shouldRejectDial`
// precondition work across PWA+iOS — a rep with an in-flight PWA sim must
// not be able to start another sim on iOS.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../lib/twilio', () => ({
  client: { conferences: jest.fn() },
  VoiceResponse: function () {},
  generateAccessToken: jest.fn(),
}));
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  getConference: jest.fn(),
  updateConference: jest.fn(),
  removeConference: jest.fn(),
  listActiveConferences: jest.fn().mockReturnValue([]),
  claimLeadDial: jest.fn(),
}));
jest.mock('../../lib/twilio-webhook', () => ({
  makeTwilioWebhook: () => (_req, _res, next) => next(),
}));
jest.mock('../../lib/live-analysis', () => ({ cleanupCall: jest.fn() }));
jest.mock('../../lib/conversation-pipeline', () => ({ cleanupConversation: jest.fn() }));
jest.mock('../../lib/equipment-pipeline', () => ({ cleanupPipelineState: jest.fn() }));
jest.mock('../../lib/slack', () => ({ sendSlackAlert: jest.fn() }));
jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn(), flush: jest.fn() }));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { listActiveConferences } = require('../../lib/conference');
const { __testSetUser } = require('../../middleware/auth');

let nextUserId = 10000;
function mockBearerUser(identity, role = 'external_caller') {
  const id = nextUserId++;
  __testSetUser({ id, email: `${identity}@joruva.com`, identity, role, displayName: identity });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

let app;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/call', require('../call'));
});

afterAll(() => {
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockImplementation(() => { throw new Error('no session'); });
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  listActiveConferences.mockReturnValue([]); // no live conferences in these tests
});

describe('GET /api/call/active — sim visibility', () => {
  test('non-admin rep with own in-progress sim sees type:sim entry', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 7,
        caller_identity: 'kate',
        difficulty: 'medium',
        created_at: new Date('2026-05-19T10:00:00Z'),
        status: 'in-progress',
        monitor_listen_url: null,
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/call/active')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0]).toMatchObject({
      type: 'sim',
      simCallId: 7,
      conferenceName: 'sim-7',
      startedBy: 'kate',
      leadName: 'Mike Garza',
      simStatus: 'in-progress',
    });
  });

  test('non-admin SQL filters by caller_identity (other reps’ sims invisible)', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get('/api/call/active')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    // First call is the sim SELECT (no live conferences are listed by mock).
    // Assert it carries caller_identity = $1 AND status = 'in-progress' shape.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/caller_identity = \$1/);
    expect(sql).toMatch(/status = 'in-progress'/);
    expect(sql).not.toMatch(/'scoring'/); // scoring is admin-only
    expect(params).toEqual(['kate']);
  });

  test('non-admin does NOT see scoring sims (only in-progress)', async () => {
    mockBearerUser('kate');
    // Even if DB had a row in 'scoring' state, the SQL filter excludes it.
    // We assert by SQL shape (above) and by absence: empty rows → empty calls.
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get('/api/call/active')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls).toEqual([]);
  });

  test('admin sees all sims (own + others, in-progress + scoring)', async () => {
    mockBearerUser('tom', 'admin');
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 11, caller_identity: 'kate', difficulty: 'easy', created_at: new Date(), status: 'in-progress', monitor_listen_url: null },
        { id: 12, caller_identity: 'paul', difficulty: 'hard', created_at: new Date(), status: 'scoring', monitor_listen_url: null },
      ],
      rowCount: 2,
    });

    const res = await request(app)
      .get('/api/call/active')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls).toHaveLength(2);
    expect(res.body.calls.map(c => c.startedBy).sort()).toEqual(['kate', 'paul']);

    // SQL must include both statuses + no caller_identity filter
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/IN \('in-progress', 'scoring'\)/);
    expect(sql).not.toMatch(/caller_identity = \$1/);
    expect(params).toEqual([]);
  });

  test('?identity=<me> filter narrows to own conferences (live + sim alike)', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 21, caller_identity: 'kate', difficulty: 'easy', created_at: new Date(), status: 'in-progress', monitor_listen_url: null },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/call/active?identity=kate')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls.every(c => c.startedBy === 'kate')).toBe(true);
  });
});
