// jsec-vr1s regression tests: the ownership guard on POST /api/call/mute,
// exercised through the REAL lib/conference store.
//
// (The parenthetical that used to sit here said POST /api/call/join is
// "deliberately unguarded — it is a preflight". That was true until jsec-r0k6.
// /join now performs the admin-or-owner check AND mints the ticket voice.js
// requires, so it is the authorization step rather than a preflight. Its own
// coverage lives in call-join-authz.test.js and voice-join-authz.test.js.)
//
// The guard these tests pin was dead code in production for months: it read
// `conf.callerIdentity`, but createConference stores the owner as
// `startedBy`, so the check short-circuited on undefined and ANY
// external_caller could mute participants on any rep's live call. The tests
// that existed at the time mocked getConference to return hand-built objects
// WITH a callerIdentity key, so they could not catch the field mismatch.
// Every seed below goes through createConference on purpose; if the guard
// and the store ever disagree on the owner field again, the non-owner tests
// fail 200 !== 403.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/twilio', () => {
  const participants = jest.fn(() => ({ update: jest.fn().mockResolvedValue({}) }));
  participants.list = jest.fn().mockResolvedValue([]);
  participants.create = jest.fn().mockResolvedValue({});
  const conferences = jest.fn(() => ({
    update: jest.fn().mockResolvedValue({}),
    participants,
  }));
  conferences.list = jest.fn().mockResolvedValue([]);
  return { client: { conferences } };
});
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
}));

// Same per-request auth shaping as call-end-inbound-auth.test.js:
// bearerOrApiKeyOrSession is the only middleware/auth export call.js uses.
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
const { client } = require('../../lib/twilio');
const { createConference, updateConference, removeConference } = require('../../lib/conference');

const CONF = 'nucleus-call-owned-by-kate';

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
  // Seed the way /initiate does: createConference, then the SID lands via
  // updateConference. The store maps callerIdentity → startedBy; the guards
  // must read the field the store writes, which is what these tests pin.
  createConference(CONF, {
    callerIdentity: 'kate',
    to: '+16025550001',
    contactName: 'Lead',
    companyName: null,
    contactId: null,
    dbRowId: 1,
  });
  updateConference(CONF, { conferenceSid: 'CFguard' });
});

describe('POST /api/call/mute — ownership guard (jsec-vr1s)', () => {
  test('non-owner external_caller is 403 and Twilio is never touched', async () => {
    await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'paul')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: true })
      .expect(403);

    expect(client.conferences).not.toHaveBeenCalled();
  });

  test('owner can mute participants on their own conference', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'kate')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: true })
      .expect(200);

    expect(res.body).toEqual({ success: true, muted: true });
    expect(client.conferences).toHaveBeenCalledWith('CFguard');
  });

  test('owner match is case-insensitive (display-cased identity, 001z)', async () => {
    await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'Kate')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: false })
      .expect(200);
  });

  test('admin bypasses ownership on any conference', async () => {
    await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'system')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: true })
      .expect(200);
  });

  test('ownerless conference is admin-only (fail closed, not fail open)', async () => {
    // createConference refuses a missing owner, so an ownerless conference
    // can only exist through state corruption — simulate that through the
    // real store's own API. Pins the `owner !== ''` half of the guard: a
    // "simplified" bare-equality compare would let '' === '' fall through
    // and reopen the hole for any principal with an empty identity.
    updateConference(CONF, { startedBy: undefined });

    await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'caller')
      .set('x-test-identity', 'kate')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: true })
      .expect(403);

    await request(await listenLoopback(app))
      .post('/api/call/mute')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'system')
      .send({ conferenceName: CONF, participantCallSid: 'CA1', muted: true })
      .expect(200);
  });
});
