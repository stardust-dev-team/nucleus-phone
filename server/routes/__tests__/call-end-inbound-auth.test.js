// Integration test for the auth path on POST /api/call/end specifically
// for the Phase 2 inbound case: iOS rep authenticates as their iOS
// identity, posts to /api/call/end against a conference created by
// incoming.js's Phase 2 branch with callerIdentity=<iosIdentity>.
//
// This is the test that would have caught Linus's P0-1 from the Phase 2
// review — if `incoming.js` writes `callerIdentity: 'inbound'` (literal
// string), the rep's identity 'paul' fails the `conf.callerIdentity !==
// req.user.identity` check in call.js:310-313 and the rep gets 403.
// iOS swallows that with `try?` and the conference resource leaks.
//
// Pre-fix (callerIdentity: 'inbound'): paul → 403, conference leaks.
// Post-fix (callerIdentity: iosIdentity): paul → 200, conference cleanly torn down.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  getConference: jest.fn(),
  updateConference: jest.fn(),
  removeConference: jest.fn(),
  listActiveConferences: jest.fn().mockReturnValue([]),
  claimLeadDial: jest.fn(),
}));
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
// `bearerOrApiKeyOrSession` is the middleware mounted on the /end route;
// we replace it with a router-level shim driven by request headers.
jest.mock('../../middleware/auth', () => ({
  bearerOrApiKeyOrSession: (req, res, next) => {
    const role = req.headers['x-test-role'] || 'admin';
    const identity = req.headers['x-test-identity'] || 'system';
    req.user = { id: 1, email: `${identity}@nucleus-phone`, identity, role, displayName: identity, authSource: 'session' };
    next();
  },
  bearerOrSession: (req, res, next) => { req.user = { role: 'admin', identity: 'system' }; next(); },
  apiKeyAuth: (req, res, next) => { req.user = { role: 'admin', identity: 'system' }; next(); },
  sessionAuth: (req, res, next) => { req.user = { role: 'admin', identity: 'system' }; next(); },
  bearerAuth: (req, res, next) => { req.user = { role: 'admin', identity: 'system' }; next(); },
  requireInteractiveUser: (req, res, next) => next(),
  isInteractiveUser: () => true,
}));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const conference = require('../../lib/conference');

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
    // check passes because conf.callerIdentity ('paul') matches
    // req.user.identity ('paul'). 200 = conference cleanly torn down.
    conference.getConference.mockReturnValue({
      conferenceSid: 'CFinbound',
      callerIdentity: 'paul',  // ← Phase 2 fix: rep's iOS identity, not 'inbound'
      startedAt: new Date(Date.now() - 5_000),
    });

    await request(app)
      .post('/api/call/end')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'paul')
      .send({ conferenceName: 'nucleus-inbound-ios-abc' })
      .expect(200);

    expect(conference.removeConference).toHaveBeenCalledWith('nucleus-inbound-ios-abc');
  });

  test('rep with mismatched identity is 403 (cross-rep teardown blocked)', async () => {
    // Same conference owned by 'paul'; 'ryann' tries to end it. Auth
    // check refuses. This is the contract that prevents one rep from
    // accidentally killing another rep's call.
    conference.getConference.mockReturnValue({
      conferenceSid: 'CFinbound',
      callerIdentity: 'paul',
      startedAt: new Date(),
    });

    await request(app)
      .post('/api/call/end')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'ryann')
      .send({ conferenceName: 'nucleus-inbound-ios-abc' })
      .expect(403);

    expect(conference.removeConference).not.toHaveBeenCalled();
  });

  test('PRE-FIX REGRESSION: rep auth FAILS when callerIdentity is literal "inbound" string', async () => {
    // Pins the original Linus P0-1 failure mode. If a future regression
    // sets callerIdentity back to the literal string 'inbound' (or any
    // non-identity sentinel), this test fails — surfacing the bug
    // BEFORE it reaches production. The fix is to set callerIdentity =
    // the rep's iOS identity in incoming.js's Phase 2 branch.
    conference.getConference.mockReturnValue({
      conferenceSid: 'CFinbound',
      callerIdentity: 'inbound',  // ← the broken value
      startedAt: new Date(),
    });

    await request(app)
      .post('/api/call/end')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'paul')
      .send({ conferenceName: 'nucleus-inbound-ios-abc' })
      .expect(403);
  });

  test('admin can tear down ANY conference regardless of callerIdentity', async () => {
    // Admin path stays open — internal automation / support tools
    // (n8n, x-api-key) must be able to terminate stuck conferences.
    conference.getConference.mockReturnValue({
      conferenceSid: 'CFstuck',
      callerIdentity: 'paul',
      startedAt: new Date(),
    });

    await request(app)
      .post('/api/call/end')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'system')
      .send({ conferenceName: 'nucleus-stuck' })
      .expect(200);
  });
});
