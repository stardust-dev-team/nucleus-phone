// jsec-z4ff: POST /api/sim/call must register the practice call in the
// conference store — in EVERY mode, not just the iOS one.
//
// The live-analysis socket keys subscriptions by conference name and now
// authorizes them against lib/conference. `simCallIos` already called
// createConference; the browser and phone arms of POST /api/sim/call did not.
// So the authorization change would have denied every rep their OWN practice
// call in the PWA — no transcript, no equipment detections, no Conversation
// Navigator — because `sim-<id>` simply wasn't in the store.
//
// That is the same failure mode caught and fixed for inbound conferences, one
// consumer of the same socket over. It was found by review AFTER the first pass
// shipped, which is why these tests exist: the fix is registration, not a
// weaker check, and nothing else pins it.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../config/team.json', () => ({
  members: [
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
  onConferenceRemoved: jest.fn(),
}));
jest.mock('../../lib/vapi', () => ({
  createOutboundCall: jest.fn(),
  stopCall: jest.fn(),
  stopCallAndLog: jest.fn(),
  getCall: jest.fn(),
}));
jest.mock('../../lib/sim-scorer', () => ({ scoreTranscript: jest.fn() }));
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn(), sendAdminReport: jest.fn(), sendSystemAlert: jest.fn(),
  formatSimScorecard: jest.fn(), formatAdminReport: jest.fn(),
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
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { createConference } = require('../../lib/conference');
const { createOutboundCall } = require('../../lib/vapi');
const { __testSetUser } = require('../../middleware/auth');

afterEach(closeLoopbackServers);

let app;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.VAPI_SIM_EASY_ID = 'assistant-easy';
  process.env.VAPI_PUBLIC_KEY = 'pk-test';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/sim', require('../sim'));
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.VAPI_SIM_EASY_ID;
  delete process.env.VAPI_PUBLIC_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  __testSetUser({ id: 9001, email: 'kate@joruva.com', identity: 'kate', role: 'external_caller', displayName: 'Kate' });
  jwt.verify.mockReturnValue({ userId: 9001 });
  // SQL-aware: the guards must see NO live call and NO in-progress sim, while
  // the INSERT returns the new row id. A blanket mock makes both guards fire
  // and the route 409s before ever reaching the code under test.
  pool.query.mockImplementation((sql) => {
    const q = String(sql);
    if (q.includes('FROM nucleus_phone_calls') || q.includes('FROM sim_call_scores')) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (q.includes('INSERT INTO sim_call_scores')) {
      return Promise.resolve({ rows: [{ id: 42 }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
});

// /call sits behind the sessionAuth mount (sim.js), so it wants the cookie —
// a bearer token 401s here.
const post = async (body) => request(await listenLoopback(app))
  .post('/api/sim/call')
  .set('Cookie', 'nucleus_session=tok')
  // sessionAuth requires this on non-GET — its CSRF guard (HTML forms cannot
  // set custom headers). Without it the route 403s before reaching the handler.
  .set('X-Requested-With', 'XMLHttpRequest')
  .send(body);

describe('POST /api/sim/call registers the conference (jsec-z4ff)', () => {
  test('browser mode registers sim-<id>, owned by the rep who started it', async () => {
    const res = await post({ difficulty: 'easy', mode: 'browser' });
    expect(res.statusCode).toBe(200);

    expect(createConference).toHaveBeenCalledTimes(1);
    const [name, state] = createConference.mock.calls[0];
    expect(name).toBe('sim-42');
    // Ownership is the whole point — this is what the socket authorizes against.
    expect(state.callerIdentity).toBe('kate');
  });

  test('phone mode registers it too', async () => {
    createOutboundCall.mockResolvedValue({ id: 'vapi-1', monitor: {} });

    const res = await post({ difficulty: 'easy', mode: 'phone', phone: '+16025551234' });
    expect(res.statusCode).toBe(200);

    expect(createConference).toHaveBeenCalledTimes(1);
    const [name, state] = createConference.mock.calls[0];
    expect(name).toBe('sim-42');
    expect(state.callerIdentity).toBe('kate');
  });
});
