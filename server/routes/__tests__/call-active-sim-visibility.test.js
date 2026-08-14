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
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { listActiveConferences } = require('../../lib/conference');
const { __testSetUser } = require('../../middleware/auth');
const { client } = require('../../lib/twilio');


afterEach(closeLoopbackServers);
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

    const res = await request(await listenLoopback(app))
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

    await request(await listenLoopback(app))
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

    const res = await request(await listenLoopback(app))
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

    const res = await request(await listenLoopback(app))
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

    const res = await request(await listenLoopback(app))
      .get('/api/call/active?identity=kate')
      .set('Authorization', 'Bearer fake-jwt')
      .expect(200);

    expect(res.body.calls.every(c => c.startedBy === 'kate')).toBe(true);
  });
});

// zht.5: the LIVE half of /api/call/active is scoped by identity the same way the sim half
// already was. The property under test is "a non-admin can never see another rep's live
// conference", and it must hold for EVERY shape the client can send — named, absent, or empty.
describe('GET /api/call/active — live-call scoping (zht.5)', () => {
  const liveConf = (startedBy, phone) => ({
    conferenceName: `nucleus-call-${startedBy}`,
    conferenceSid: null, // no Twilio lookup needed for these assertions
    startedAt: new Date(),
    startedBy,
    leadPhone: phone,
  });
  const noSims = () => pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // One loopback-bound listener per test, so `get` stays synchronous and callers can chain
  // .expect() off it directly (afterEach(closeLoopbackServers) at the top of the file closes it).
  let srv;
  beforeEach(async () => { srv = await listenLoopback(app); });
  const get = (url) => request(srv).get(url).set('Authorization', 'Bearer fake-jwt');

  test('non-admin does NOT see another rep\'s live call when NO identity param is sent', async () => {
    // THE ONE THAT MATTERS. An earlier version of this change 403'd only when a non-admin NAMED
    // someone else, so dropping the param returned everything — and an earlier version of THIS
    // test asserted that leak as correct behaviour. It is not.
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('tom', '+16025550001')]);
    noSims();

    const res = await get('/api/call/active').expect(200);

    expect(res.body.calls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });

  test('non-admin does NOT see another rep\'s live call via an EMPTY identity param', async () => {
    // Reachable in production: the iOS coordinator's identity defaults to "" and is sent
    // unconditionally, so `?identity=` is a real request shape, not a contrived one.
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('tom', '+16025550001')]);
    noSims();

    const res = await get('/api/call/active?identity=').expect(200);

    expect(res.body.calls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });

  test('non-admin sees ONLY their own call when the list contains both', async () => {
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([
      liveConf('tom', '+16025550001'),
      liveConf('kate', '+16025550002'),
    ]);
    noSims();

    const res = await get('/api/call/active').expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('kate');
    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });

  test('non-admin naming ANOTHER rep is refused (403)', async () => {
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('tom', '+16025550001')]);

    const res = await get('/api/call/active?identity=tom').expect(403);

    expect(res.body.error).toMatch(/identity/i);
    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });

  test('non-admin naming their OWN identity gets their call', async () => {
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('kate', '+16025550002')]);
    noSims();

    const res = await get('/api/call/active?identity=kate').expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('kate');
  });

  test('own identity in DISPLAY case returns the call, not an empty 200', async () => {
    // Pins `requested.toLowerCase()` — nothing more. It does NOT cover the filter's case
    // handling (by then `requested` is already canonical); the display-cased startedBy test
    // below covers that half. Asserting the status alone would be vacuous either way: the
    // failure this guards against is a clean 200 with an EMPTY list, which iOS reads as
    // "no active call" and dials again.
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('kate', '+16025550002')]);
    noSims();

    const res = await get('/api/call/active?identity=Kate').expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('kate');
  });

  test('admin sees every rep\'s live calls, and may filter to one', async () => {
    mockBearerUser('tom', 'admin');
    listActiveConferences.mockReturnValue([
      liveConf('tom', '+16025550001'),
      liveConf('kate', '+16025550002'),
    ]);
    noSims();

    const all = await get('/api/call/active').expect(200);
    expect(all.body.calls).toHaveLength(2);

    mockBearerUser('tom', 'admin');
    listActiveConferences.mockReturnValue([
      liveConf('tom', '+16025550001'),
      liveConf('kate', '+16025550002'),
    ]);
    noSims();
    const one = await get('/api/call/active?identity=kate').expect(200);
    expect(one.body.calls).toHaveLength(1);
    expect(one.body.calls[0].startedBy).toBe('kate');
  });

  test('a DISPLAY-CASED startedBy still matches its owner (inbound path does not canonicalize)', async () => {
    // /initiate lowercases callerIdentity at the boundary, but incoming.js passes iosIdentity
    // straight into createConference, so startedBy is NOT guaranteed canonical. Without the
    // normalisation on the filter side, kate would get a clean 200 with zero calls for a
    // conference that is hers — and iOS reads an empty list as "no active call, dial again".
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('Kate', '+16025550002')]);
    noSims();

    const res = await get('/api/call/active').expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('Kate');
  });

  test('a DISPLAY-CASED user identity still matches their own lowercase conference', async () => {
    // Pins the OTHER half of the canonicalization: ownIdentity.toLowerCase(). Drop it and a
    // user row of 'Kate' scopes against 'Kate' while startedBy is 'kate' — a clean 200 with an
    // empty list, i.e. the iOS double-dial fail-open, reintroduced from the user side.
    mockBearerUser('Kate');
    listActiveConferences.mockReturnValue([liveConf('kate', '+16025550002')]);
    noSims();

    const res = await get('/api/call/active').expect(200);

    expect(res.body.calls).toHaveLength(1);
  });

  test('a non-admin with NO usable identity fails CLOSED (403), not open', async () => {
    // Latent rather than reachable today (every write path canonicalizes and the column is
    // NOT NULL), but ownIdentity === '' would make scopeIdentity falsy and skip the filter
    // entirely — a full leak. The sim half already fails closed on this input; this makes the
    // live half agree.
    mockBearerUser('');
    listActiveConferences.mockReturnValue([liveConf('tom', '+16025550001')]);

    const res = await get('/api/call/active').expect(403);

    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });

  test('admin ?identity= narrows SIMS too, not just live calls', async () => {
    // Pass-3 finding: moving the filter upstream of enrichment covered only the LIVE list, so
    // an admin asking for kate still got every rep's sim rows — while the route's header
    // comment promised the filter "applies uniformly to both 'live' and 'sim' entries".
    mockBearerUser('tom', 'admin');
    listActiveConferences.mockReturnValue([]);
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, caller_identity: 'kate', difficulty: 'medium', created_at: new Date(), status: 'in-progress', monitor_listen_url: null },
        { id: 2, caller_identity: 'paul', difficulty: 'hard', created_at: new Date(), status: 'scoring', monitor_listen_url: null },
      ],
      rowCount: 2,
    });

    const res = await get('/api/call/active?identity=kate').expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('kate');
  });

  test('another rep’s conference is never ENRICHED — no Twilio call for data you cannot see', async () => {
    // The whole justification for scoping before enrichment. Untested until now: every other
    // fixture uses conferenceSid: null, so the enrichment branch never ran and moving the
    // filter back downstream left the suite green. A real sid makes the property observable.
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([
      { conferenceName: 'nucleus-call-tom', conferenceSid: 'CF_TOM', startedAt: new Date(), startedBy: 'tom', leadPhone: '+16025550001' },
    ]);
    noSims();
    client.conferences.mockClear();

    const res = await get('/api/call/active').expect(200);

    expect(res.body.calls).toHaveLength(0);
    // Billed REST call, on a 3s poll, for a conference this caller is not allowed to see.
    expect(client.conferences).not.toHaveBeenCalled();
  });

  test('a REPEATED identity param is rejected (400), never silently unfiltered', async () => {
    // Express turns ?identity=a&identity=b into an array, which a `typeof === "string"` test
    // downgrades to "no filter". Kept as a 400 rather than leaning on default scoping: a caller
    // asking to be scoped deserves an error, not a quietly different answer.
    mockBearerUser('kate');
    listActiveConferences.mockReturnValue([liveConf('tom', '+16025550001')]);

    const res = await get('/api/call/active?identity=kate&identity=tom').expect(400);
    expect(JSON.stringify(res.body)).not.toContain('6025550001');
  });
});
