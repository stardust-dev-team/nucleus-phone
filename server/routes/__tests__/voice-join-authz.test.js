// jsec-r0k6 regression tests: POST /api/voice with Action==='join' is the REAL
// join — the branch that puts a second pair of ears into a live customer call.
//
// Before this fix it built conference TwiML from a client-supplied
// `ConferenceName` with no ownership and no role check. The request arrives
// from Twilio, so it carries no session and no req.user; there was nothing on
// it to authorize against. Any authenticated principal — including a commission
// contractor — could mint a device token for their own identity and
// Device.connect({Action:'join', ConferenceName:'<a rep's live call>'}) to
// listen in silently. The POST /api/call/join preflight was no defense: it
// returned JSON, touched no Twilio, and an attacker simply skipped it.
//
// The fix does not guard the client-supplied name — it stops accepting one. The
// conference is resolved from a server-minted ticket (lib/join-tickets.js). The
// tests below therefore split into two families, and BOTH matter:
//
//   1. "no valid ticket is refused" — the obvious half.
//   2. "a valid ticket for conference A cannot be steered at conference B by
//      the request body" — the half that pins the actual security property.
//      A future refactor that reads `ConferenceName` back out of req.body
//      would still pass family 1 while silently reopening the hole.
//
// Tickets are issued through the REAL lib/join-tickets module, never a mock.
// Hand-built authorization objects that production never produces are exactly
// what hid the dead jsec-vr1s guards for two months.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/slack', () => ({
  sendSystemAlert: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const { sendSystemAlert } = require('../../lib/slack');
const {
  issueJoinTicket, _clearJoinTickets, TICKET_TTL_MS,
} = require('../../lib/join-tickets');
const { createConference, updateConference, removeConference } = require('../../lib/conference');

const VICTIM_CONF = 'nucleus-call-kates-live-customer-call';
const OWN_CONF = 'nucleus-call-my-own-conference';

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice', require('../voice'));
});

afterEach(() => {
  _clearJoinTickets();
  for (const name of [OWN_CONF, VICTIM_CONF, 'sim-42', 'nucleus-call-initiate-1']) removeConference(name);
  jest.restoreAllMocks();
  return closeLoopbackServers();
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
  // voice.js re-checks getConference at redeem time, so a ticket alone is not
  // enough — the conference must actually exist. Seed it through the REAL
  // store, the same way /initiate does.
  createConference(OWN_CONF, {
    callerIdentity: 'tom', to: '+16025550002', contactName: 'Lead', dbRowId: 99,
  });
  updateConference(OWN_CONF, { conferenceSid: 'CFownlive' });
});

/* ───────── family 1: no valid ticket is refused ───────── */

describe('POST /api/voice Action=join — refuses a join without a valid ticket (jsec-r0k6)', () => {
  test('the original attack — naming a victim conference with no ticket at all — is refused', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', ConferenceName: VICTIM_CONF, Muted: 'true' });

    expect(res.statusCode).toBe(403);
    // The point is not merely the status code: no TwiML that could place the
    // caller anywhere may be emitted, and the victim's conference name must not
    // appear in the response at all.
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('a forged ticket is refused', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', ConferenceName: VICTIM_CONF, JoinTicket: 'not-a-real-ticket' });

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('an expired ticket is refused', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true);
    // Walk the clock past the TTL rather than waiting on it.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + TICKET_TTL_MS + 1);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket });

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a ticket whose conference has already ended is refused, not used to conjure an empty one', async () => {
    // Tickets outlive conferences: removeConference runs at normal call end
    // while a ticket minted seconds earlier is still inside its TTL. Twilio
    // creates a conference on demand, so passing a dead name would silently
    // make a NEW empty conference and — with startConferenceOnEnter:false —
    // park the joiner in silence forever.
    const ticket = issueJoinTicket(OWN_CONF, true);
    removeConference(OWN_CONF);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket });

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a refused join raises a system alert — expected volume is zero, so a burst is signal', async () => {
    await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', ConferenceName: 'nucleus-call-alert-probe-1' });

    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sendSystemAlert.mock.calls[0][0]).toMatch(/entry refused/i);
  });

  test('repeat refusals for the same conference are throttled, but each one is still logged', async () => {
    // An alert an attacker can trigger on demand is a channel they can flood to
    // bury a real alert. The dull case is likelier: one browser on a
    // pre-deploy bundle firing one 🔴 per retry. Throttling must never lose the
    // EVENT though — only the notification — so the server log is asserted too.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = await listenLoopback(app);

    for (let i = 0; i < 3; i += 1) {
      await request(server).post('/api/voice').send({ Action: 'join', ConferenceName: 'nucleus-call-flood' });
    }
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('nucleus-call-flood'))).toHaveLength(3);

    // A DIFFERENT conference is a different signal and must not be suppressed.
    await request(server).post('/api/voice').send({ Action: 'join', ConferenceName: 'nucleus-call-flood-2' });
    expect(sendSystemAlert).toHaveBeenCalledTimes(2);
  });
});

/* ───────── family 2: the request body cannot steer a valid ticket ───────── */

describe('POST /api/voice Action=join — the ticket, not the request body, names the conference', () => {
  test('a valid ticket joins the conference it was issued for', async () => {
    const ticket = issueJoinTicket(OWN_CONF, false);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
    // Unchanged contract from the pre-fix behaviour: a joiner leaving must
    // never tear the conference down for everyone else.
    expect(res.text).toMatch(/endConferenceOnExit="false"/);
    expect(res.text).toMatch(/startConferenceOnEnter="false"/);
  });

  test('SECURITY: a ticket for my own conference cannot be pointed at someone else\'s by naming theirs', async () => {
    // This is the mutation that matters. Re-introducing `ConferenceName` from
    // req.body on this path passes every test in family 1 and fails only here.
    const ticket = issueJoinTicket(OWN_CONF, true);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket, ConferenceName: VICTIM_CONF });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('SECURITY: muted comes from the ticket, so a silent-join grant cannot be flipped to an open mic', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket, Muted: 'false' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/muted="true"/);
  });

  test('an unmuted grant stays unmuted even if the body asks for muted', async () => {
    const ticket = issueJoinTicket(OWN_CONF, false);

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ Action: 'join', JoinTicket: ticket, Muted: 'true' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/muted="false"/);
  });

  test('a ticket is a join-only concept — the initiate path does not use one', async () => {
    createConference('nucleus-call-initiate-1', {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Lead', dbRowId: 1,
    });

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: 'nucleus-call-initiate-1', CallSid: 'CA0000000000000001' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('>nucleus-call-initiate-1</Conference>');
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
  });
});

/* ───────── family 3: the initiate branch is not a back door ───────── */

// Found by the jsec-r0k6 Linus review, which built a working proof: guarding
// only Action==='join' closed the front door and left this one open in the same
// handler. The attacker does not need Action:'join' — they need to OMIT Action.
//
// The fall-through branch is the WORSE of the two. It emits no `muted`
// attribute, so Twilio defaults to an open mic rather than silent listening; it
// sets endConferenceOnExit="true", so the intruder hanging up terminates the
// victim's live customer call; and it stamps their CallSid onto the victim's
// nucleus_phone_calls row, breaking the transcription mapping for the real rep.
//
// The guard is an invariant on conference lifecycle rather than an ownership
// check, because this webhook has no session to check against: every conference
// a client may legitimately enter is registered server-side BEFORE the client
// learns its name, and conferenceSid is only set AFTER this TwiML is served.
describe('POST /api/voice (no Action) — the initiate branch is not a back door into a live call (jsec-r0k6)', () => {
  test('SECURITY: omitting Action does not conference the caller into a rep\'s LIVE call', async () => {
    createConference(VICTIM_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 7,
    });
    // A live call: the conference-start callback has landed a SID.
    updateConference(VICTIM_CONF, { conferenceSid: 'CFvictimlive' });

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: VICTIM_CONF, CallSid: 'CAattacker' });

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('SECURITY: the refused initiate never reaches the victim\'s DB row', async () => {
    // The pre-fix branch ran `UPDATE nucleus_phone_calls SET caller_call_sid`
    // BEFORE emitting TwiML, so an intruder overwrote the real rep's CallSid
    // and broke transcription mapping even if the audio had failed.
    createConference(VICTIM_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 7,
    });
    updateConference(VICTIM_CONF, { conferenceSid: 'CFvictimlive' });

    await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: VICTIM_CONF, CallSid: 'CAattacker' });

    const wroteCallerSid = pool.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('SET caller_call_sid')
    );
    expect(wroteCallerSid).toBe(false);
  });

  test('SECURITY: an unknown conference name is refused rather than conjured into existence', async () => {
    // Twilio creates a conference on demand, so an unguarded name is not merely
    // a failed lookup — it is a brand-new conference with the attacker in it.
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: 'sim-4', CallSid: 'CAattacker' });

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a legitimate outbound initiate — known conference, not yet started — still works', async () => {
    // The regression that matters in the other direction: this is the path
    // every real outbound call takes, from the PWA and from the iOS dialer.
    createConference(OWN_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Lead', dbRowId: 2,
    });

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: OWN_CONF, CallSid: 'CAlegit' });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
    expect(res.text).toContain('<Transcription');
  });

  test('a sim conference behaves the same — allowed before it starts, refused once live', async () => {
    createConference('sim-42', {
      callerIdentity: 'blake', to: null, contactName: 'Mike Garza', dbRowId: 42,
    });

    const before = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: 'sim-42', CallSid: 'CAsim' });
    expect(before.statusCode).toBe(200);

    updateConference('sim-42', { conferenceSid: 'CFsimlive' });

    const after = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ ConferenceName: 'sim-42', CallSid: 'CAintruder' });
    expect(after.statusCode).toBe(403);
  });
});
