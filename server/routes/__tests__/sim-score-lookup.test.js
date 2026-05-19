jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../config/team.json', () => ({
  members: [
    { identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' },
    { identity: 'kate', name: 'Kate', email: 'kate@joruva.com', role: 'external_caller' },
    { identity: 'paul', name: 'Paul', email: 'paul@joruva.com', role: 'external_caller' },
  ],
}));
jest.mock('../../lib/twilio', () => ({
  generateAccessToken: jest.fn(),
  client: {},
  VoiceResponse: function () {},
}));
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  updateConference: jest.fn(),
  removeConference: jest.fn(),
  getConference: jest.fn(),
  listActiveConferences: jest.fn().mockReturnValue([]),
  claimLeadDial: jest.fn(),
}));
jest.mock('../../lib/vapi', () => ({
  createOutboundCall: jest.fn(),
  stopCall: jest.fn(),
  stopCallAndLog: jest.fn(),
  getCall: jest.fn(),
}));
jest.mock('../../lib/sim-scorer', () => ({ scoreTranscript: jest.fn() }));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn(),
  sendAdminReport: jest.fn(),
  sendSystemAlert: jest.fn(),
  formatSimScorecard: jest.fn(),
  formatAdminReport: jest.fn(),
}));
jest.mock('../../lib/live-analysis', () => ({ broadcast: jest.fn() }));
jest.mock('../../lib/equipment-pipeline', () => ({ processEquipmentChunk: jest.fn() }));
jest.mock('../../lib/conversation-pipeline', () => ({
  processConversationChunk: jest.fn(),
  getCallEventLog: jest.fn().mockReturnValue([]),
  cleanupConversation: jest.fn(),
}));
jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn(), flush: jest.fn() }));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { __testSetUser } = require('../../middleware/auth');

let nextUserId = 9000;
function mockBearerUser(identity, role = 'external_caller') {
  const id = nextUserId++;
  __testSetUser({ id, email: `${identity}@joruva.com`, identity, role, displayName: identity });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = 'test-key';
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sim', require('../sim'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockImplementation(() => { throw new Error('no session'); });
  pool.query.mockReset();
});

const SCORED_ROW = {
  id: 42,
  caller_identity: 'kate',
  status: 'scored',
  call_grade: 'A',
  score_overall: '9.2',
  score_rapport: '9.0',
  score_discovery: '9.5',
  score_objection: '9.0',
  score_product: '9.0',
  score_close: '9.5',
  note_rapport: 'Excellent NTMA reference',
  note_discovery: 'Got CFM + voltage + AS9100 in 2 minutes',
  note_objection: 'Acknowledge-first on all 4',
  note_product: 'Right JRS model called out',
  note_close: 'Got verbal yes on quote',
  top_strength: 'Discovery',
  top_improvement: 'Slow down on objections',
  caller_debrief: 'You absolutely crushed it.',
  scored_at: new Date('2026-05-19T15:30:00Z'),
};

describe('GET /api/sim/call/:id/score', () => {
  test('401 without auth', async () => {
    await request(app).get('/api/sim/call/42/score').expect(401);
  });

  test('returns scoring contract for status=scored (camelCase nested)', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [SCORED_ROW], rowCount: 1 });

    const res = await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body).toEqual({
      status: 'scored',
      grade: 'A',
      overall: 9.2,
      dimensions: {
        rapport: 9.0, discovery: 9.5, objection: 9.0, product: 9.0, close: 9.5,
      },
      notes: {
        rapport: 'Excellent NTMA reference',
        discovery: 'Got CFM + voltage + AS9100 in 2 minutes',
        objection: 'Acknowledge-first on all 4',
        product: 'Right JRS model called out',
        close: 'Got verbal yes on quote',
      },
      topStrength: 'Discovery',
      topImprovement: 'Slow down on objections',
      callerDebrief: 'You absolutely crushed it.',
      scoredAt: '2026-05-19T15:30:00.000Z',
    });
  });

  test('numeric columns return as JS numbers (no string scores)', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [SCORED_ROW], rowCount: 1 });

    const res = await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(typeof res.body.overall).toBe('number');
    for (const dim of ['rapport', 'discovery', 'objection', 'product', 'close']) {
      expect(typeof res.body.dimensions[dim]).toBe('number');
    }
  });

  test('status=in-progress projects as scoring with null dimensions/notes', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({
      rows: [{
        ...SCORED_ROW,
        status: 'in-progress',
        call_grade: null,
        score_overall: null,
        score_rapport: null, score_discovery: null, score_objection: null,
        score_product: null, score_close: null,
        note_rapport: null, note_discovery: null, note_objection: null,
        note_product: null, note_close: null,
        top_strength: null, top_improvement: null, caller_debrief: null,
        scored_at: null,
      }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.status).toBe('scoring');
    expect(res.body.dimensions).toBeNull();
    expect(res.body.notes).toBeNull();
    expect(res.body.grade).toBeNull();
    expect(res.body.scoredAt).toBeNull();
  });

  test('status=score-failed projects as failed', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({
      rows: [{ ...SCORED_ROW, status: 'score-failed' }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.status).toBe('failed');
    // Even though row carries score data, dimensions+notes are null when
    // status is not 'scored' — bead contract.
    expect(res.body.dimensions).toBeNull();
    expect(res.body.notes).toBeNull();
  });

  test('404 when row is missing', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await request(app)
      .get('/api/sim/call/999/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(404);
  });

  test('400 on non-numeric :id', async () => {
    mockBearerUser('kate');
    await request(app)
      .get('/api/sim/call/not-a-number/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(400);
  });

  test('RBAC: other rep’s call returns 404 (not 403)', async () => {
    mockBearerUser('paul'); // paul is external_caller, not admin
    pool.query.mockResolvedValueOnce({ rows: [SCORED_ROW], rowCount: 1 }); // kate's row
    await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(404);
  });

  test('RBAC: admin can read any rep’s score', async () => {
    mockBearerUser('tom', 'admin');
    pool.query.mockResolvedValueOnce({ rows: [SCORED_ROW], rowCount: 1 }); // kate's row
    const res = await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);
    expect(res.body.status).toBe('scored');
  });

  test('owner can read own score', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [SCORED_ROW], rowCount: 1 });
    await request(app)
      .get('/api/sim/call/42/score')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);
  });
});
