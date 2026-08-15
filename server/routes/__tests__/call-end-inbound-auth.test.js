// Integration test for the auth path on POST /api/call/end specifically
// for the Phase 2 inbound case: iOS rep authenticates as their iOS
// identity, posts to /api/call/end against a conference created by
// incoming.js's Phase 2 branch with callerIdentity=<iosIdentity>.
//
// jsec-vr1s: this file exercises the REAL lib/conference store. The previous
// version mocked getConference to return hand-built objects carrying a
// `callerIdentity` key — a shape createConference never writes (the owner is
// stored as `startedBy`) — so the guard these tests "verified" was dead in
// production while every test here stayed green. Seeding through the real
// createConference is the point: if the route guard and the store ever
// disagree on the owner field again, the mismatch tests below fail 200 !== 403.
//
// The original Linus P0-1 input-side contract — incoming.js's Phase 2 branch
// must pass the rep's iOS identity, never the literal 'inbound' sentinel —
// is pinned where that code actually runs: incoming.test.js (asserts
// createConference is called with callerIdentity: 'paul'). This file pins
// the route-side half: /end authorizes against what the store returns.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/twilio', () => {
  const conferences = jest.fn(() => ({
    update: jest.fn().mockResolvedValue({}),
    participants: { list: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
  }));
  conferences.list = jest.fn().mockResolvedValue([]);
  return { client: { conferences } };
});
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
}));

// Mock the auth middleware composer so the test can choose what req.user
// looks like per request (admin vs rep, matching identity vs mismatched).
// `bearerOrApiKeyOrSession` is the ONLY middleware function call.js
// destructures from `../middleware/auth` (verified: `grep -n "middleware/auth"
// server/routes/call.js` returns one match). Keeping the mock surface tight
// to exactly what's imported prevents misleading-export drift (R2 N1):
// the previous mock exported `requireInteractiveUser` and `isInteractiveUser`
// — neither exists on the real module (real name is `isInteractiveCaller`).
jest.mock('../../middleware/auth', () => ({
  bearerOrApiKeyOrSession: (req, res, next) => {
    const role = req.headers['x-test-role'] || 'admin';
    const identity = req.headers['x-test-identity'] || 'system';
    req.user = { id: 1, email: `${identity}@nucleus-phone`, identity, role, displayName: identity, authSource: 'session' };
    next();
  },
}));

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const {
  createConference, getConference, updateConference, removeConference,
} = require('../../lib/conference');

const CONF = 'nucleus-inbound-ios-abc';

// Seed exactly the way production does: incoming.js's Phase 2 branch calls
// createConference with callerIdentity=<owner>, then the /status webhook
// stamps the conference SID. No hand-built conf objects.
function seedConference(owner) {
  createConference(CONF, {
    callerIdentity: owner,
    to: null,
    contactName: '+16025550000',
    companyName: null,
    contactId: null,
    dbRowId: 1,
    direction: 'inbound',
  });
  updateConference(CONF, { conferenceSid: 'CFinbound' });
}

afterEach(() => {
  removeConference(CONF);
  return closeLoopbackServers();
});
let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/call', require('../call'));
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/call/end — Phase 2 inbound auth path (Linus P0-1 regression test)', () => {
  test('rep with matching iOS identity can tear down their Phase 2 inbound conference', async () => {
    // Phase 2 fix: incoming.js creates the conference with
    // callerIdentity=<iosIdentity>. When 'paul' calls endCall, the auth
    // check passes because conf.startedBy ('paul') matches
    // req.user.identity ('paul'). 200 = conference cleanly torn down.
    seedConference('paul');

    await request(await listenLoopback(app))
      .post('/api/call/end')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'paul')
      .send({ conferenceName: CONF })
      .expect(200);

    expect(getConference(CONF)).toBeUndefined();
  });

  test('rep with mismatched identity is 403 (cross-rep teardown blocked)', async () => {
    // Same conference owned by 'paul'; 'ryann' tries to end it. Auth
    // check refuses. This is the contract that prevents one rep from
    // killing another rep's call — and the test that fails 200 !== 403
    // if the guard ever reads a field the store doesn't write (jsec-vr1s).
    seedConference('paul');

    await request(await listenLoopback(app))
      .post('/api/call/end')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'ryann')
      .send({ conferenceName: CONF })
      .expect(403);

    expect(getConference(CONF)).toBeDefined();
  });

  test('admin can tear down ANY conference regardless of owner', async () => {
    // Admin path stays open — internal automation / support tools
    // (n8n, x-api-key) must be able to terminate stuck conferences.
    seedConference('paul');

    await request(await listenLoopback(app))
      .post('/api/call/end')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'system')
      .send({ conferenceName: CONF })
      .expect(200);
  });
});
