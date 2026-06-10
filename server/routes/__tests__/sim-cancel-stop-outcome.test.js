/**
 * nucleus-phone-nja: POST /api/sim/call/:id/cancel must not silently swallow a
 * failed Vapi stop. When stopCallAndLog returns 'failed' the route escalates to
 * sendSystemAlert (a live call may still be burning minutes) and echoes the
 * outcome as `stopOutcome` in the HTTP response. A successful stop alerts no one.
 */
jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../config/team.json', () => ({
  members: [
    { identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' },
    { identity: 'kate', name: 'Kate', email: 'kate@joruva.com', role: 'external_caller' },
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
const { stopCallAndLog, getCall } = require('../../lib/vapi');
const { sendSystemAlert } = require('../../lib/slack');
const { scoreTranscript } = require('../../lib/sim-scorer');

let nextUserId = 9000;
function mockBearerUser(identity, role = 'external_caller') {
  const id = nextUserId++;
  __testSetUser({ id, email: `${identity}@joruva.com`, identity, role, displayName: identity });
  jwt.verify.mockReturnValue({ userId: id });
  return id;
}

// sessionAuth is cookie-based and CSRF-guards non-GET requests: it needs a
// nucleus_session cookie (jwt.verify is mocked to return {userId}) plus the
// X-Requested-With header.
function cancelReq() {
  return request(app)
    .post('/api/sim/call/77/cancel')
    .set('Cookie', 'nucleus_session=fake')
    .set('X-Requested-With', 'XMLHttpRequest');
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
  // Default: any unspecified query (the scoring-branch UPDATEs + fire-and-forget
  // pipeline writes) succeeds with an empty result.
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  // Transcript present on the first fetch → route takes the scoring branch and
  // never hits the 3s retry sleep.
  getCall.mockResolvedValue({ artifact: { transcript: 'hello there', recordingUrl: null } });
  // Keep the fire-and-forget scoring pipeline a no-op (error short-circuits it).
  scoreTranscript.mockResolvedValue({ error: true, message: 'scoring skipped in test' });
  // Production calls sendSystemAlert(...).catch(...) — return a promise.
  sendSystemAlert.mockResolvedValue(undefined);
});

const IN_PROGRESS_ROW = {
  id: 77,
  vapi_call_id: '11111111-2222-3333-4444-555555555555',
  status: 'in-progress',
  caller_identity: 'kate',
  difficulty: 'medium',
};

describe('POST /api/sim/call/:id/cancel — stop-outcome surfacing (nja)', () => {
  test('Vapi stop FAILED → escalates to sendSystemAlert and returns stopOutcome:failed', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [IN_PROGRESS_ROW], rowCount: 1 }); // initial SELECT
    stopCallAndLog.mockResolvedValue('failed');

    const res = await cancelReq().expect(200);

    expect(res.body.stopOutcome).toBe('failed');
    expect(stopCallAndLog).toHaveBeenCalledWith(IN_PROGRESS_ROW.vapi_call_id);
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    const [title, blocks] = sendSystemAlert.mock.calls[0];
    expect(title).toMatch(/Vapi stop FAILED/i);
    expect(JSON.stringify(blocks)).toContain(IN_PROGRESS_ROW.vapi_call_id);
  });

  test('Vapi stop succeeded → no alert and returns stopOutcome:stopped', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [IN_PROGRESS_ROW], rowCount: 1 });
    stopCallAndLog.mockResolvedValue('stopped');

    const res = await cancelReq().expect(200);

    expect(res.body.stopOutcome).toBe('stopped');
    expect(sendSystemAlert).not.toHaveBeenCalled();
  });

  test('already-ended → no alert and returns stopOutcome:already-ended', async () => {
    mockBearerUser('kate');
    pool.query.mockResolvedValueOnce({ rows: [IN_PROGRESS_ROW], rowCount: 1 });
    stopCallAndLog.mockResolvedValue('already-ended');

    const res = await cancelReq().expect(200);

    expect(res.body.stopOutcome).toBe('already-ended');
    expect(sendSystemAlert).not.toHaveBeenCalled();
  });
});
