// jsec-r0k6: POST /api/call/join is the authorization step for listening in on
// a live call. It decides WHO may join, and mints the ticket that voice.js's
// Action==='join' branch requires (voice-join-authz.test.js covers the other
// side of that contract).
//
// Policy, set by Tom on 2026-08-14: monitoring another rep's live customer call
// is ADMIN-ONLY. A rep may re-join a conference they started themselves; nobody
// else may join theirs. An ownerless conference is admin-only, not open.
//
// The property that actually protects a customer call is NEGATIVE and easy to
// lose in a refactor: a denied caller must not RECEIVE a ticket. voice.js trusts
// any ticket it can resolve, so a version that 403s the status but still returns
// a ticket in the body would hand an attacker exactly what they need while
// passing a status-code-only test. Every denial test below therefore asserts on
// the response body as well as the status.
//
// (Minting a ticket that is never returned would be wasteful but not a leak —
// so these tests deliberately pin "no ticket in the denial response", which is
// the real property, rather than "issueJoinTicket was not called", which is a
// proxy for it.)
//
// Conferences are seeded through the REAL lib/conference store (see the header
// of call-ownership-guards.test.js for why hand-built conference objects are
// banned here).

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
  sendSystemAlert: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../middleware/auth', () => ({
  bearerOrApiKeyOrSession: (req, res, next) => {
    const role = req.headers['x-test-role'] || 'admin';
    const identity = req.headers['x-test-identity'] || 'system';
    const authSource = req.headers['x-test-authsource'] || 'session';
    req.user = { id: 1, email: `${identity}@nucleus-phone`, identity, role, displayName: identity, authSource };
    next();
  },
}));

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const { createConference, updateConference, removeConference } = require('../../lib/conference');
const { redeemJoinTicket, _clearJoinTickets } = require('../../lib/join-tickets');

const CONF = 'nucleus-call-owned-by-kate';

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/call', require('../call'));
});

afterEach(() => {
  removeConference(CONF);
  _clearJoinTickets();
  return closeLoopbackServers();
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  createConference(CONF, {
    callerIdentity: 'kate',
    to: '+16025550001',
    contactName: 'Lead',
    companyName: null,
    contactId: null,
    dbRowId: 1,
  });
  updateConference(CONF, { conferenceSid: 'CFjoin' });
});

const join = async (role, identity, body = {}) => request(await listenLoopback(app))
  .post('/api/call/join')
  .set('x-test-role', role)
  .set('x-test-identity', identity)
  .send({ conferenceName: CONF, muted: true, ...body });

describe('POST /api/call/join — who may listen (jsec-r0k6)', () => {
  test('a commission contractor cannot join a rep\'s call, and gets NO ticket', async () => {
    // external_caller is the role the hierarchy comment in middleware/rbac.js
    // assigns to the commission contractors. This is the exact scenario the
    // bead was filed for.
    const res = await join('external_caller', 'blake');

    expect(res.statusCode).toBe(403);
    expect(res.body.joinTicket).toBeUndefined();
  });

  test('another internal rep cannot join a rep\'s call either — admin-only, not staff-wide', async () => {
    const res = await join('caller', 'paul');

    expect(res.statusCode).toBe(403);
    expect(res.body.joinTicket).toBeUndefined();
  });

  test('an admin may join any conference, and the ticket resolves to it', async () => {
    const res = await join('admin', 'tom');

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.joinTicket).toBe('string');
    expect(redeemJoinTicket(res.body.joinTicket, 'tom')).toEqual({ conferenceName: CONF, muted: true, identity: 'tom' });
  });

  test('the owning rep may re-join their own conference', async () => {
    const res = await join('caller', 'kate');

    expect(res.statusCode).toBe(200);
    // jsec-gsx0: the ticket is bound to KATE — the caller it was issued to —
    // not to whoever presents it later. An admin cannot pick it up either.
    expect(redeemJoinTicket(res.body.joinTicket, 'kate')).toEqual({ conferenceName: CONF, muted: true, identity: 'kate' });
    expect(redeemJoinTicket(res.body.joinTicket, 'tom')).toBeNull();
  });

  test('owner match is case-insensitive (display-cased identity, 001z)', async () => {
    const res = await join('caller', 'Kate');

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.joinTicket).toBe('string');
  });

  test('muted:false is carried onto the ticket — an open-mic join is authorized as such', async () => {
    const res = await join('admin', 'tom', { muted: false });

    expect(redeemJoinTicket(res.body.joinTicket, 'tom')).toEqual({ conferenceName: CONF, muted: false, identity: 'tom' });
  });

  test('muted defaults to false when the body omits it, and the response shape is stable', async () => {
    // Ported from call.test.js rather than dropped when that file's /join tests
    // moved to an API-key refusal: the `!!muted` default and the response shape
    // {conferenceName, muted, joinTicket} had no other coverage, and the join()
    // helper here always sends muted:true unless told otherwise.
    const res = await request(await listenLoopback(app))
      .post('/api/call/join')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'tom')
      .send({ conferenceName: CONF })
      .expect(200);

    const { joinTicket, ...rest } = res.body;
    expect(rest).toEqual({ conferenceName: CONF, muted: false });
    expect(typeof joinTicket).toBe('string');
    expect(redeemJoinTicket(joinTicket, 'tom')).toEqual({
      conferenceName: CONF, muted: false, identity: 'tom',
    });
  });

  test('an ownerless conference is admin-only (fail closed, not fail open)', async () => {
    // createConference refuses a missing owner, so this state can only arise
    // through corruption — reproduce it through the real store's own API, the
    // same way call-ownership-guards.test.js does.
    updateConference(CONF, { startedBy: undefined });

    const denied = await join('caller', 'kate');
    expect(denied.statusCode).toBe(403);
    expect(denied.body.joinTicket).toBeUndefined();

    const allowed = await join('admin', 'tom');
    expect(allowed.statusCode).toBe(200);
    expect(typeof allowed.body.joinTicket).toBe('string');
  });

  test('jsec-gsx0 N2: EACH half of the API-key guard is exercised alone', async () => {
    // The guard reads `authSource === 'api_key' || identity === 'system'`, and
    // review found either clause could be deleted with the suite still green —
    // the only principal used satisfied both, so one guard was cosplaying as
    // two. These are the two principals that separate them.
    //
    // (a) api_key auth carrying a NORMAL identity — the realistic automation
    //     case. A ticket minted here is bound to an identity that can never
    //     appear on a Voice SDK leg, so it would be unredeemable.
    const apiKeyCaller = await request(await listenLoopback(app))
      .post('/api/call/join')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'tom')
      .set('x-test-authsource', 'api_key')
      .send({ conferenceName: CONF, muted: true });
    expect(apiKeyCaller.statusCode).toBe(403);
    expect(apiKeyCaller.body.joinTicket).toBeUndefined();

    // (b) a SESSION principal whose identity is the 'system' sentinel.
    const systemSession = await request(await listenLoopback(app))
      .post('/api/call/join')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'system')
      .set('x-test-authsource', 'session')
      .send({ conferenceName: CONF, muted: true });
    expect(systemSession.statusCode).toBe(403);
    expect(systemSession.body.joinTicket).toBeUndefined();
  });

  test('an unknown conference 404s before any ownership question is asked', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/call/join')
      .set('x-test-role', 'admin')
      .set('x-test-identity', 'tom')
      .send({ conferenceName: 'nucleus-call-does-not-exist', muted: true });

    expect(res.statusCode).toBe(404);
    expect(res.body.joinTicket).toBeUndefined();
  });
});
