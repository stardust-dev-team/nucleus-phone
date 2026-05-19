/**
 * B2b defensive cleanup: when Vapi's end-of-call-report webhook arrives for a
 * sim row that has a Twilio conference_sid set (iOS sim), the handler must
 * explicitly end the Twilio conference and clear the in-memory map entry.
 *
 * The bridging TwiML's endConferenceOnExit:true normally handles this on the
 * happy path — this test pins the belt-and-suspenders cleanup so a misconfigured
 * bridge TwiML doesn't strand the rep's iOS leg in dead audio.
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../config/team.json', () => ({
  members: [{ identity: 'tom', name: 'Tom', email: 'tom@joruva.com', role: 'admin' }],
}));

jest.mock('../../lib/twilio', () => {
  const conferences = jest.fn(() => ({ update: jest.fn().mockResolvedValue({}) }));
  return {
    generateAccessToken: jest.fn(),
    client: { conferences },
    VoiceResponse: function () {},
  };
});

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

jest.mock('../../lib/sim-scorer', () => ({
  // resolve with .error=true so the post-200 pipeline short-circuits and we
  // don't need to mock Slack/persist formatting just to test the cleanup.
  scoreTranscript: jest.fn().mockResolvedValue({ error: true, message: 'skip in test' }),
}));

jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn(),
  sendAdminReport: jest.fn(),
  sendSystemAlert: jest.fn().mockResolvedValue(true),
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
jest.mock('../../lib/health-tracker', () => ({ touch: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { client } = require('../../lib/twilio');
const conference = require('../../lib/conference');

let app;
beforeAll(() => {
  process.env.VAPI_WEBHOOK_SECRET = 'test-secret';
  process.env.NUCLEUS_PHONE_API_KEY = 'test-key';
  process.env.JWT_SECRET = 'test-jwt';
  app = express();
  app.use(express.json());
  app.use('/api/sim', require('../sim'));
});

afterAll(() => {
  delete process.env.VAPI_WEBHOOK_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
});

const endOfCallEnvelope = {
  message: {
    type: 'end-of-call-report',
    call: { id: 'vapi-call-1', duration: 90, cost: 0.05 },
    artifact: { transcript: 'mock transcript', recordingUrl: 'https://rec' },
  },
};

describe('Vapi webhook end-of-call — defensive conference cleanup (B2b)', () => {
  test('ends Twilio conference + clears in-memory map for iOS sim row', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 42, caller_identity: 'kate', difficulty: 'easy', conference_sid: 'CF777', conference_name: 'sim-42' }],
      rowCount: 1,
    });
    conference.getConference.mockReturnValue({ type: 'sim' });
    const update = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValue({ update });

    await request(app)
      .post('/api/sim/webhook')
      .set('x-vapi-secret', 'test-secret')
      .send(endOfCallEnvelope)
      .expect(200);

    // wait for fire-and-forget cleanup branch (which is on the synchronous
    // path after the row UPDATE, but the surrounding response was sent before)
    await new Promise(r => setImmediate(r));

    expect(client.conferences).toHaveBeenCalledWith('CF777');
    expect(update).toHaveBeenCalledWith({ status: 'completed' });
    expect(conference.removeConference).toHaveBeenCalledWith('sim-42');
  });

  test('PWA browser-mode sim (no conference_sid): no Twilio call', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 42, caller_identity: 'kate', difficulty: 'easy', conference_sid: null, conference_name: null }],
      rowCount: 1,
    });

    await request(app)
      .post('/api/sim/webhook')
      .set('x-vapi-secret', 'test-secret')
      .send(endOfCallEnvelope)
      .expect(200);

    await new Promise(r => setImmediate(r));

    expect(client.conferences).not.toHaveBeenCalled();
    expect(conference.removeConference).not.toHaveBeenCalled();
  });

  test('Twilio 404 on conference.update is swallowed (expected on happy path)', async () => {
    pool.query.mockResolvedValue({
      rows: [{ id: 42, caller_identity: 'kate', difficulty: 'easy', conference_sid: 'CF777', conference_name: 'sim-42' }],
      rowCount: 1,
    });
    conference.getConference.mockReturnValue({ type: 'sim' });
    const update = jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    client.conferences.mockReturnValue({ update });

    // No exception should escape — the 200 already shipped before this branch.
    await request(app)
      .post('/api/sim/webhook')
      .set('x-vapi-secret', 'test-secret')
      .send(endOfCallEnvelope)
      .expect(200);

    await new Promise(r => setImmediate(r));
    expect(update).toHaveBeenCalled();
    // In-memory map cleanup still runs even when Twilio side was already gone.
    expect(conference.removeConference).toHaveBeenCalledWith('sim-42');
  });
});
