jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
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
    participants: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
  }));
  conferences.list = jest.fn().mockResolvedValue([]);

  return {
    client: { conferences },
  };
});
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const conference = require('../../lib/conference');
const { client } = require('../../lib/twilio');
const { __testSetUser } = require('../../middleware/auth');

const API_KEY = 'test-api-key';

// Seed a session-cookie caller for tests that need to exercise the
// non-admin auth path (e.g. zht.5's identity-filter 403). API-key auth
// always grants synthetic admin, so it can't reach the 403 branch.
let nextUserId = 7000;
function mockSessionUser(identity, role = 'caller') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@joruva.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
  return { id, identity, role };
}

let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_API_KEY = API_KEY;
  process.env.JWT_SECRET = 'test-secret';
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/call', require('../call'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_API_KEY;
  delete process.env.JWT_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── POST /api/call/initiate ───────────── */

describe('POST /api/call/initiate', () => {
  test('returns 401 without auth', async () => {
    await request(app).post('/api/call/initiate').expect(401);
  });

  test('returns 400 when to is missing', async () => {
    const res = await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({ callerIdentity: 'tom' })
      .expect(400);

    expect(res.body.error).toMatch(/to and callerIdentity required/);
  });

  test('returns 400 when callerIdentity is missing', async () => {
    const res = await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({ to: '+16025551234' })
      .expect(400);

    expect(res.body.error).toMatch(/to and callerIdentity required/);
  });

  test('returns 400 for non-E.164 phone number', async () => {
    const res = await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({ to: '6025551234', callerIdentity: 'tom' })
      .expect(400);

    expect(res.body.error).toMatch(/E\.164/);
  });

  test('rejects short E.164 numbers', async () => {
    await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({ to: '+123', callerIdentity: 'tom' })
      .expect(400);
  });

  test('creates DB row, conference, and returns callId', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

    const res = await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({
        to: '+16025551234',
        callerIdentity: 'tom',
        contactName: 'Jane Doe',
        companyName: 'Acme Corp',
        contactId: '101',
      })
      .expect(200);

    expect(res.body.callId).toBe(42);
    expect(res.body.conferenceName).toMatch(/^nucleus-call-/);

    // DB insert happened with correct params
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO nucleus_phone_calls'),
      [res.body.conferenceName, 'tom', '+16025551234', 'Jane Doe', 'Acme Corp', '101']
    );

    // In-memory conference created
    expect(conference.createConference).toHaveBeenCalledWith(
      res.body.conferenceName,
      expect.objectContaining({
        callerIdentity: 'tom',
        to: '+16025551234',
        dbRowId: 42,
      })
    );
  });

  test('returns 500 on DB error', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app)
      .post('/api/call/initiate')
      .set('x-api-key', API_KEY)
      .send({ to: '+16025551234', callerIdentity: 'tom' })
      .expect(500);

    expect(res.body.error).toMatch(/Failed to initiate/);
  });
});

/* ───────────── POST /api/call/join ───────────── */

describe('POST /api/call/join', () => {
  test('returns 401 without auth', async () => {
    await request(app).post('/api/call/join').expect(401);
  });

  test('returns 404 when conference not found', async () => {
    conference.getConference.mockReturnValue(null);

    await request(app)
      .post('/api/call/join')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'nucleus-call-missing', callerIdentity: 'tom' })
      .expect(404);
  });

  test('returns conference info on success', async () => {
    conference.getConference.mockReturnValue({ conferenceName: 'nucleus-call-abc' });

    const res = await request(app)
      .post('/api/call/join')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'nucleus-call-abc', callerIdentity: 'tom', muted: true })
      .expect(200);

    expect(res.body).toEqual({ conferenceName: 'nucleus-call-abc', muted: true });
  });

  test('muted defaults to false', async () => {
    conference.getConference.mockReturnValue({ conferenceName: 'nucleus-call-abc' });

    const res = await request(app)
      .post('/api/call/join')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'nucleus-call-abc', callerIdentity: 'tom' })
      .expect(200);

    expect(res.body.muted).toBe(false);
  });
});

/* ───────────── POST /api/call/mute ───────────── */

describe('POST /api/call/mute', () => {
  test('returns 404 when conference not found', async () => {
    conference.getConference.mockReturnValue(null);

    await request(app)
      .post('/api/call/mute')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'x', participantCallSid: 'CA1', muted: true })
      .expect(404);
  });

  test('returns 404 when conference has no SID yet', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: null });

    await request(app)
      .post('/api/call/mute')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'x', participantCallSid: 'CA1', muted: true })
      .expect(404);
  });

  test('toggles mute via Twilio and returns success', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: 'CF123' });

    // The mock returns a nested object: conferences(sid).participants(callSid).update()
    const mockUpdate = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValue({
      participants: jest.fn(() => ({ update: mockUpdate })),
    });

    const res = await request(app)
      .post('/api/call/mute')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'x', participantCallSid: 'CA1', muted: true })
      .expect(200);

    expect(res.body).toEqual({ success: true, muted: true });
    expect(mockUpdate).toHaveBeenCalledWith({ muted: true });
  });

  test('returns 500 when Twilio fails', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: 'CF123' });
    client.conferences.mockReturnValue({
      participants: jest.fn(() => ({
        update: jest.fn().mockRejectedValue(new Error('Twilio down')),
      })),
    });

    await request(app)
      .post('/api/call/mute')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'x', participantCallSid: 'CA1', muted: false })
      .expect(500);
  });
});

/* ───────────── GET /api/call/active ───────────── */

describe('GET /api/call/active', () => {
  test('returns 401 without auth', async () => {
    await request(app).get('/api/call/active').expect(401);
  });

  test('returns empty calls array when no active conferences', async () => {
    conference.listActiveConferences.mockReturnValue([]);

    const res = await request(app)
      .get('/api/call/active')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toEqual([]);
  });

  test('enriches conferences with Twilio participants', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      {
        conferenceName: 'nucleus-call-a',
        conferenceSid: 'CF1',
        startedAt: now,
        startedBy: 'tom',
        leadName: 'Jane',
        leadCompany: 'Acme',
        leadPhone: '+16025551234',
        participants: [],
      },
    ]);

    client.conferences.mockReturnValue({
      participants: {
        list: jest.fn().mockResolvedValue([
          { callSid: 'CA1', muted: false, hold: false },
          { callSid: 'CA2', muted: true, hold: false },
        ]),
      },
    });

    const res = await request(app)
      .get('/api/call/active')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    const call = res.body.calls[0];
    expect(call.conferenceName).toBe('nucleus-call-a');
    expect(call.participants).toHaveLength(2);
    expect(call.participants[0].callSid).toBe('CA1');
    expect(call.duration).toBeGreaterThanOrEqual(0);
  });

  test('returns empty participants when Twilio fetch fails', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      {
        conferenceName: 'nucleus-call-b',
        conferenceSid: 'CF2',
        startedAt: now,
        startedBy: 'kate',
        leadName: null,
        leadCompany: null,
        leadPhone: '+16025559999',
        participants: [],
      },
    ]);

    client.conferences.mockReturnValue({
      participants: {
        list: jest.fn().mockRejectedValue(new Error('gone')),
      },
    });

    const res = await request(app)
      .get('/api/call/active')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls[0].participants).toEqual([]);
  });

  // zht.5 — ?identity= filter for iOS OutboundCallCoordinator precheck

  test('?identity= filters live calls to that rep only', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      { conferenceName: 'nucleus-call-tom', conferenceSid: null, startedAt: now, startedBy: 'tom', participants: [] },
      { conferenceName: 'nucleus-call-kate', conferenceSid: null, startedAt: now, startedBy: 'kate', participants: [] },
    ]);

    const res = await request(app)
      .get('/api/call/active?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('tom');
    expect(res.body.calls[0].type).toBe('live');
  });

  test('?identity= excludes sim entries even for admin', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      { conferenceName: 'nucleus-call-tom', conferenceSid: null, startedAt: now, startedBy: 'tom', participants: [] },
    ]);
    // The handler should NOT issue this query when ?identity= is set —
    // mock it anyway so a regression that re-adds the sim block is
    // caught by the excluded-from-response assertion below.
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 99, caller_identity: 'tom', difficulty: 'easy', created_at: now, status: 'in-progress', monitor_listen_url: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/call/active?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].type).toBe('live');
    expect(res.body.calls.some((c) => c.type === 'sim')).toBe(false);
    // Stronger guarantee: the sim DB query specifically was never issued.
    // Asserting on the exact query (rather than `pool.query` overall) keeps
    // the test from breaking if a future logging/audit query lands in this
    // handler — only the optimization-relevant invariant is locked.
    const queriedSql = pool.query.mock.calls.map((c) => c[0]).join(' ');
    expect(queriedSql).not.toMatch(/FROM sim_call_scores/);
  });

  test('?identity= returning no matches yields empty calls array', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      { conferenceName: 'nucleus-call-kate', conferenceSid: null, startedAt: now, startedBy: 'kate', participants: [] },
    ]);

    const res = await request(app)
      .get('/api/call/active?identity=tom')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toEqual([]);
  });

  test('non-admin asking for own identity is allowed', async () => {
    const user = mockSessionUser('kate', 'caller');
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([
      { conferenceName: 'nucleus-call-kate', conferenceSid: null, startedAt: now, startedBy: 'kate', participants: [] },
      { conferenceName: 'nucleus-call-tom', conferenceSid: null, startedAt: now, startedBy: 'tom', participants: [] },
    ]);

    const res = await request(app)
      .get(`/api/call/active?identity=${user.identity}`)
      .set('Cookie', 'nucleus_session=stub')
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].startedBy).toBe('kate');
  });

  test('non-admin asking for someone else gets 403', async () => {
    mockSessionUser('kate', 'caller');

    const res = await request(app)
      .get('/api/call/active?identity=tom')
      .set('Cookie', 'nucleus_session=stub')
      .expect(403);

    expect(res.body.error).toMatch(/identity must match/);
    // listActiveConferences must not be called — the 403 is pre-work.
    expect(conference.listActiveConferences).not.toHaveBeenCalled();
  });

  test('without ?identity=, admin still sees sim entries (existing behavior preserved)', async () => {
    const now = new Date();
    conference.listActiveConferences.mockReturnValue([]);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 7, caller_identity: 'tom', difficulty: 'medium', created_at: now, status: 'in-progress', monitor_listen_url: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .get('/api/call/active')
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body.calls).toHaveLength(1);
    expect(res.body.calls[0].type).toBe('sim');
  });

  test('repeated ?identity= params (array) returns 400, not silent empty list', async () => {
    // Express's default qs parser turns ?identity=tom&identity=kate into
    // an array. Without an explicit type guard, the array slips past the
    // 403 check (array !== string) but breaks the strict-equals filter,
    // and admins get a misleading empty list. Linus catch on first review.
    const res = await request(app)
      .get('/api/call/active?identity=tom&identity=kate')
      .set('x-api-key', API_KEY)
      .expect(400);

    expect(res.body.error).toMatch(/identity must be a single string/);
    expect(conference.listActiveConferences).not.toHaveBeenCalled();
  });
});

/* ───────────── POST /api/call/end ───────────── */

describe('POST /api/call/end', () => {
  test('returns 404 when conference not found', async () => {
    conference.getConference.mockReturnValue(null);

    await request(app)
      .post('/api/call/end')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'missing' })
      .expect(404);
  });

  test('returns 404 when conference has no SID', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: null });

    await request(app)
      .post('/api/call/end')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'no-sid' })
      .expect(404);
  });

  test('ends conference via Twilio', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: 'CF999' });
    const mockUpdate = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValue({ update: mockUpdate });

    const res = await request(app)
      .post('/api/call/end')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'nucleus-call-xyz' })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'completed' });
  });

  test('returns 500 when Twilio fails', async () => {
    conference.getConference.mockReturnValue({ conferenceSid: 'CF999' });
    client.conferences.mockReturnValue({
      update: jest.fn().mockRejectedValue(new Error('nope')),
    });

    await request(app)
      .post('/api/call/end')
      .set('x-api-key', API_KEY)
      .send({ conferenceName: 'nucleus-call-xyz' })
      .expect(500);
  });
});

/* ───────────── POST /api/call/status ───────────── */

describe('POST /api/call/status', () => {
  // No x-api-key — this route uses twilioWebhook (signature validation,
  // disabled outside production), not apiKeyAuth.
  const send = (body) =>
    request(app).post('/api/call/status').send(body);

  beforeAll(() => {
    process.env.NUCLEUS_PHONE_NUMBER = '+18005550000';
  });

  afterAll(() => {
    delete process.env.NUCLEUS_PHONE_NUMBER;
  });

  test('returns 204 for any event', async () => {
    conference.getConference.mockReturnValue(null);
    await send({ StatusCallbackEvent: 'conference-start', FriendlyName: 'x' })
      .expect(204);
  });

  test('does nothing when conference not found', async () => {
    conference.getConference.mockReturnValue(null);
    await send({
      StatusCallbackEvent: 'participant-join',
      FriendlyName: 'nucleus-call-gone',
      ConferenceSid: 'CF1',
      CallSid: 'CA1',
    }).expect(204);

    expect(conference.updateConference).not.toHaveBeenCalled();
    expect(conference.claimLeadDial).not.toHaveBeenCalled();
  });

  /* ── Lead-dial on conference-start ── */

  test('saves ConferenceSid and dials lead on conference-start', async () => {
    const conf = {
      conferenceSid: null,
      leadPhone: '+16025551234',
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);
    conference.claimLeadDial.mockReturnValue(true);
    const mockCreate = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValue({
      participants: { create: mockCreate },
    });

    await send({
      StatusCallbackEvent: 'conference-start',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    // Saved SID to in-memory state
    expect(conference.updateConference).toHaveBeenCalledWith(
      'nucleus-call-abc', { conferenceSid: 'CF100' }
    );

    // Persisted SID to DB (fire-and-forget in production — mock resolves
    // synchronously so the assertion works without flushing microtasks)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE nucleus_phone_calls SET conference_sid'),
      ['CF100', 'nucleus-call-abc']
    );

    // Dialed the lead
    expect(mockCreate).toHaveBeenCalledWith({
      from: '+18005550000',
      to: '+16025551234',
      earlyMedia: true,
      beep: false,
      endConferenceOnExit: true,
    });
  });

  /* ── Lead-dial on participant-join ── */

  test('dials lead on participant-join (races conference-start)', async () => {
    const conf = {
      conferenceSid: null,
      leadPhone: '+16025559999',
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);
    conference.claimLeadDial.mockReturnValue(true);
    const mockCreate = jest.fn().mockResolvedValue({});
    client.conferences.mockReturnValue({
      participants: { create: mockCreate },
    });

    await send({
      StatusCallbackEvent: 'participant-join',
      FriendlyName: 'nucleus-call-def',
      ConferenceSid: 'CF200',
      CallSid: 'CA50',
      Muted: 'false',
    }).expect(204);

    expect(mockCreate).toHaveBeenCalledWith({
      from: '+18005550000',
      to: '+16025559999',
      earlyMedia: true,
      beep: false,
      endConferenceOnExit: true,
    });
  });

  /* ── Double-dial prevention ── */

  test('skips lead dial when claimLeadDial returns false', async () => {
    const conf = {
      conferenceSid: 'CF100',
      leadPhone: '+16025551234',
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);
    conference.claimLeadDial.mockReturnValue(false);

    const mockCreate = jest.fn();
    client.conferences.mockReturnValue({
      participants: { create: mockCreate },
    });

    await send({
      StatusCallbackEvent: 'conference-start',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('skips SID update when conferenceSid already set', async () => {
    const conf = {
      conferenceSid: 'CF100',
      leadPhone: '+16025551234',
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);
    conference.claimLeadDial.mockReturnValue(false);

    await send({
      StatusCallbackEvent: 'conference-start',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    expect(conference.updateConference).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('skips dial when leadPhone is null', async () => {
    const conf = {
      conferenceSid: null,
      leadPhone: null,
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);

    await send({
      StatusCallbackEvent: 'conference-start',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    expect(conference.claimLeadDial).not.toHaveBeenCalled();
  });

  /* ── Twilio dial failure is swallowed ── */

  test('returns 204 even when Twilio dial fails', async () => {
    const conf = {
      conferenceSid: null,
      leadPhone: '+16025551234',
      participants: [],
    };
    conference.getConference.mockReturnValue(conf);
    conference.claimLeadDial.mockReturnValue(true);

    client.conferences.mockReturnValue({
      participants: { create: jest.fn().mockRejectedValue(new Error('Twilio down')) },
    });

    await send({
      StatusCallbackEvent: 'conference-start',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);
  });

  /* ── Participant tracking ── */

  test('tracks participant on join', async () => {
    const participants = [];
    conference.getConference.mockReturnValue({
      conferenceSid: 'CF100',
      leadPhone: null,
      participants,
    });

    await send({
      StatusCallbackEvent: 'participant-join',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
      CallSid: 'CA77',
      Muted: 'true',
    }).expect(204);

    expect(participants).toHaveLength(1);
    expect(participants[0]).toEqual(expect.objectContaining({
      callSid: 'CA77',
      muted: true,
    }));
  });

  test('removes participant on leave', async () => {
    const participants = [
      { callSid: 'CA1', muted: false, joinedAt: new Date() },
      { callSid: 'CA2', muted: false, joinedAt: new Date() },
    ];
    const conf = { participants };
    conference.getConference.mockReturnValue(conf);

    await send({
      StatusCallbackEvent: 'participant-leave',
      FriendlyName: 'nucleus-call-abc',
      CallSid: 'CA1',
    }).expect(204);

    expect(conf.participants).toHaveLength(1);
    expect(conf.participants[0].callSid).toBe('CA2');
  });

  /* ── Conference end ── */

  test('updates DB and removes conference on end', async () => {
    const NOW = 1_700_000_120_000;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);

    const startedAt = new Date(NOW - 120_000); // exactly 2 min ago
    conference.getConference.mockReturnValue({
      startedAt,
      participants: [],
    });
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    await send({
      StatusCallbackEvent: 'conference-end',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'completed'"),
      [120, 'CF100', 'nucleus-call-abc']
    );

    expect(conference.removeConference).toHaveBeenCalledWith('nucleus-call-abc');

    Date.now.mockRestore();
  });

  test('removes conference even when DB update fails', async () => {
    const startedAt = new Date(Date.now() - 10_000);
    conference.getConference.mockReturnValue({
      startedAt,
      participants: [],
    });
    pool.query.mockRejectedValueOnce(new Error('DB down'));

    await send({
      StatusCallbackEvent: 'conference-end',
      FriendlyName: 'nucleus-call-abc',
      ConferenceSid: 'CF100',
    }).expect(204);

    expect(conference.removeConference).toHaveBeenCalledWith('nucleus-call-abc');
  });
});
