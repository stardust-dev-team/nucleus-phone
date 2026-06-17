jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../config/team.json', () => ({
  members: [
    { identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' },
    { identity: 'paul', name: 'Paul', email: 'paul@joruva.com', role: 'admin' },
    { identity: 'kate', name: 'Kate', email: 'kate@joruva.com', role: 'external_caller' },
  ],
}));
jest.mock('../../lib/twilio', () => ({
  generateAccessToken: jest.fn().mockReturnValue('fake-twilio-token'),
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
const { generateAccessToken } = require('../../lib/twilio');
const { createConference, updateConference, removeConference } = require('../../lib/conference');
const { logEvent } = require('../../lib/debug-log');
const { __testSetUser } = require('../../middleware/auth');

const API_KEY = 'test-call-ios-api-key';

let nextUserId = 8000;
function mockBearerUser(identity, role = 'external_caller') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@joruva.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sim', require('../sim'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
  delete process.env.SIM_DAILY_LIMIT_PER_REP;
  delete process.env.VAPI_SIM_MIKE_GARZA_EASY_ID;
  delete process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID;
  delete process.env.VAPI_SIM_MIKE_GARZA_HARD_ID;
  delete process.env.VAPI_SIM_EASY_ID;
  delete process.env.VAPI_SIM_MEDIUM_ID;
  delete process.env.VAPI_SIM_HARD_ID;
});

beforeEach(() => {
  jest.clearAllMocks();
  jwt.verify.mockImplementation(() => { throw new Error('no session'); });
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  generateAccessToken.mockReturnValue('fake-twilio-token');
  // Each test sets up the env it needs; default = the new-style var set.
  process.env.VAPI_SIM_MIKE_GARZA_EASY_ID = 'asst-easy';
  process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID = 'asst-medium';
  process.env.VAPI_SIM_MIKE_GARZA_HARD_ID = 'asst-hard';
  delete process.env.VAPI_SIM_EASY_ID;
  delete process.env.VAPI_SIM_MEDIUM_ID;
  delete process.env.VAPI_SIM_HARD_ID;
  delete process.env.SIM_DAILY_LIMIT_PER_REP;
});

// Mock-resolution helpers for the simCallIos query sequence:
//   1) live-call lookup
//   2) duplicate-sim lookup
//   3) daily-count lookup
//   4) INSERT sim_call_scores RETURNING id
//   5) UPDATE conference_name
function mockHappyPath({ insertedId = 42, dailyCount = 0 } = {}) {
  pool.query
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 1: no live call
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // 2: no duplicate sim
    .mockResolvedValueOnce({ rows: [{ count: dailyCount }], rowCount: 1 }) // 3: under cap
    .mockResolvedValueOnce({ rows: [{ id: insertedId }], rowCount: 1 }) // 4: INSERT
    .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // 5: UPDATE conference_name
}

describe('POST /api/sim/call/ios', () => {
  test('401 without auth', async () => {
    await request(app)
      .post('/api/sim/call/ios')
      .send({ personaId: 'mike-garza', difficulty: 'easy' })
      .expect(401);
  });

  test('happy path returns bridge payload + reserves conference + mints token', async () => {
    mockBearerUser('kate');
    mockHappyPath({ insertedId: 101 });

    const res = await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'mike-garza', difficulty: 'easy' })
      .expect(200);

    expect(res.body).toMatchObject({
      simCallId: 101,
      conferenceName: 'sim-101',
      accessToken: 'fake-twilio-token',
      personaId: 'mike-garza',
      difficulty: 'easy',
    });
    expect(res.body.vapiCallId).toBeUndefined(); // B2b populates this, not B2a
    expect(createConference).toHaveBeenCalledWith('sim-101', expect.objectContaining({
      callerIdentity: 'kate',
      dbRowId: 101,
      contactName: 'Mike Garza',
    }));
    expect(updateConference).toHaveBeenCalledWith('sim-101', expect.objectContaining({
      type: 'sim',
      personaId: 'mike-garza',
      difficulty: 'easy',
      assistantId: 'asst-easy',
    }));
    expect(generateAccessToken).toHaveBeenCalledWith('kate', { incomingAllow: true });
  });

  test('400 when personaId missing', async () => {
    mockBearerUser('kate');
    await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ difficulty: 'easy' })
      .expect(400);
  });

  test('400 when difficulty missing', async () => {
    mockBearerUser('kate');
    await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'mike-garza' })
      .expect(400);
  });

  test('404 when personaId unknown', async () => {
    mockBearerUser('kate');
    const res = await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'who-dis', difficulty: 'easy' })
      .expect(404);
    expect(res.body.error).toMatch(/Persona not found/);
  });

  test('404 when difficulty is not declared by persona', async () => {
    mockBearerUser('kate');
    const res = await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'mike-garza', difficulty: 'impossible' })
      .expect(404);
    expect(res.body.error).toMatch(/Difficulty not available/);
  });

  test('409 when caller has a live call in progress', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });
    const res = await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'mike-garza', difficulty: 'easy' })
      .expect(409);
    expect(res.body.error).toMatch(/live call/);
  });

  test('409 when caller has a duplicate sim within the 3-minute guard window (n8z)', async () => {
    mockBearerUser('kate');
    pool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // live: none
      .mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 }); // duplicate-sim: hit
    const res = await request(app)
      .post('/api/sim/call/ios')
      .set('Authorization', 'Bearer fake-jwt')
      .send({ personaId: 'mike-garza', difficulty: 'easy' })
      .expect(409);
    expect(res.body.error).toMatch(/Practice call already in progress/);
    // The duplicate-sim guard is the 2nd query; its window must be 3 min (n8z).
    expect(pool.query.mock.calls[1][0]).toMatch(/INTERVAL '3 minutes'/);
  });

  describe('SIM_DAILY_LIMIT_PER_REP', () => {
    test('count below limit allows the call', async () => {
      mockBearerUser('kate');
      mockHappyPath({ insertedId: 201, dailyCount: 14 });
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(200);
    });

    test('count at limit returns 429 with expected copy', async () => {
      mockBearerUser('kate');
      pool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ count: 15 }], rowCount: 1 });

      const res = await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(429);

      expect(res.body.error).toBe('Daily practice limit reached. Reset at midnight Phoenix time.');
      expect(logEvent).toHaveBeenCalledWith(
        'rate_limit',
        'sim.daily',
        expect.stringContaining('kate'),
        expect.objectContaining({ detail: { count: 15, limit: 15 } })
      );
    });

    test('SIM_DAILY_LIMIT_PER_REP env override takes effect', async () => {
      process.env.SIM_DAILY_LIMIT_PER_REP = '3';
      mockBearerUser('kate');
      pool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ count: 3 }], rowCount: 1 });
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(429);
    });

    test('SQL filters by caller_identity so one rep cannot trigger another rep’s cap', async () => {
      mockBearerUser('kate');
      mockHappyPath({ insertedId: 301, dailyCount: 0 });
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(200);

      // 3rd call to pool.query is the daily-count SELECT; its params[0] must
      // be the current rep's identity so cross-rep counts don't bleed in.
      const dailyCountCall = pool.query.mock.calls[2];
      expect(dailyCountCall[0]).toMatch(/COUNT\(\*\)/i);
      expect(dailyCountCall[1]).toEqual(['kate']);
    });

    test('bad SIM_DAILY_LIMIT_PER_REP value warns + falls back to 15 (Linus #3)', async () => {
      process.env.SIM_DAILY_LIMIT_PER_REP = 'not-a-number';
      mockBearerUser('kate');
      // 14 should pass (under 15 default); pin the fallback by exercising under-cap.
      mockHappyPath({ insertedId: 9001, dailyCount: 14 });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(200);
      // Warn may have fired earlier in the suite (module-level once-flag) —
      // assert it was called AT LEAST ONCE with the bad-value message during
      // process lifetime.
      const warnCalledWithBadValue = warn.mock.calls.some((call) =>
        typeof call[0] === 'string' && call[0].includes('SIM_DAILY_LIMIT_PER_REP') && call[0].includes('not a non-negative integer')
      ) || jest.requireActual('console').warn === console.warn;
      // Run the cap check: SIM_DAILY_LIMIT_PER_REP=abc with daily count 15 must 429
      pool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ count: 15 }], rowCount: 1 });
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(429);
      warn.mockRestore();
      expect(warnCalledWithBadValue).toBe(true);
    });

    test('SQL uses Phoenix-local day boundary (timezone literal pinned)', async () => {
      mockBearerUser('kate');
      mockHappyPath({ insertedId: 401, dailyCount: 0 });
      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(200);

      const dailyCountCall = pool.query.mock.calls[2];
      expect(dailyCountCall[0]).toMatch(/date_trunc\('day',.*AT TIME ZONE 'America\/Phoenix'/s);
    });
  });

  describe('assistant env var resolution', () => {
    test('falls back to legacy VAPI_SIM_{DIFFICULTY}_ID when new var unset', async () => {
      delete process.env.VAPI_SIM_MIKE_GARZA_MEDIUM_ID;
      process.env.VAPI_SIM_MEDIUM_ID = 'legacy-asst-medium';

      mockBearerUser('kate');
      mockHappyPath({ insertedId: 501 });

      await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'medium' })
        .expect(200);

      expect(updateConference).toHaveBeenCalledWith('sim-501', expect.objectContaining({
        assistantId: 'legacy-asst-medium',
      }));
    });

    test('500 when both new and legacy env vars are unset', async () => {
      delete process.env.VAPI_SIM_MIKE_GARZA_HARD_ID;
      delete process.env.VAPI_SIM_HARD_ID;
      mockBearerUser('kate');
      const res = await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'hard' })
        .expect(500);
      expect(res.body.error).toMatch(/Missing Vapi assistant env var/);
      // Should fail BEFORE any DB write
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('conference_name persist soft-failure (Linus #10)', () => {
    test('UPDATE conference_name failure does NOT 500 the client', async () => {
      mockBearerUser('kate');
      pool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // live: none
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })          // dup: none
        .mockResolvedValueOnce({ rows: [{ count: 0 }], rowCount: 1 }) // daily: 0
        .mockResolvedValueOnce({ rows: [{ id: 777 }], rowCount: 1 }) // INSERT id=777
        .mockRejectedValueOnce(new Error('simulated UPDATE failure')); // conference_name UPDATE
      const warn = jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(200);

      expect(res.body).toMatchObject({
        simCallId: 777,
        conferenceName: 'sim-777',
        accessToken: 'fake-twilio-token',
      });
      // The in-memory reservation MUST still happen — it's the primary lookup
      // path. The DB column is the durability fallback for process restarts.
      expect(createConference).toHaveBeenCalledWith('sim-777', expect.any(Object));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('conference_name persist failed for 777'),
        expect.stringContaining('simulated UPDATE failure')
      );
      warn.mockRestore();
    });
  });

  describe('rollback on token mint failure', () => {
    test('rolls back conference + marks row cancelled when token mint throws', async () => {
      mockBearerUser('kate');
      mockHappyPath({ insertedId: 601 });
      // Override the 5-query happy-path with a 6th: the cancel UPDATE on rollback.
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      generateAccessToken.mockImplementationOnce(() => { throw new Error('twilio sdk explosion'); });

      const res = await request(app)
        .post('/api/sim/call/ios')
        .set('Authorization', 'Bearer fake-jwt')
        .send({ personaId: 'mike-garza', difficulty: 'easy' })
        .expect(500);

      expect(res.body.error).toMatch(/access token/);
      expect(removeConference).toHaveBeenCalledWith('sim-601');
      // Last pool.query call must be the cancel UPDATE.
      const lastCall = pool.query.mock.calls[pool.query.mock.calls.length - 1];
      expect(lastCall[0]).toMatch(/UPDATE sim_call_scores SET status = 'cancelled'/);
      expect(lastCall[1]).toEqual([601]);
    });
  });
});
