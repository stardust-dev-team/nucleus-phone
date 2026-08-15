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
// jsec-gsx0: identity comes from the REST Call resource, not from req.body.From
// (the body param is in the same namespace as client-supplied Device.connect
// params and is therefore not trustworthy). Tests drive it through this mock.
jest.mock('../../lib/twilio', () => {
  const actual = jest.requireActual('../../lib/twilio');
  return {
    VoiceResponse: actual.VoiceResponse,
    client: { calls: jest.fn() },
  };
});

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const { sendSystemAlert } = require('../../lib/slack');
const {
  issueJoinTicket, _clearJoinTickets, TICKET_TTL_MS,
} = require('../../lib/join-tickets');
const { createConference, updateConference, removeConference } = require('../../lib/conference');
const { client } = require('../../lib/twilio');

const VICTIM_CONF = 'nucleus-call-kates-live-customer-call';
const OWN_CONF = 'nucleus-call-my-own-conference';

// jsec-gsx0: /api/voice now requires Twilio's `From` (client:<identity>) on both
// branches. It is derived from the access token, so a caller cannot choose it —
// which is exactly why it can be authorized on. OWN_CONF is seeded to 'tom'.
const FROM_TOM = 'client:tom';
const FROM_ATTACKER = 'client:blake';

/** Point the mocked REST Call resource at a given `from` for this request. */
function legFrom(from) {
  client.calls.mockImplementation(() => ({
    fetch: jest.fn().mockResolvedValue({ from }),
  }));
}

/**
 * POST /api/voice as a leg whose AUTHORITATIVE from is `from`.
 *
 * Uses rest args rather than a default parameter on purpose: a default fires on
 * an EXPLICIT undefined too, so `postVoice(body, undefined)` would silently
 * become a valid tom leg — which is precisely the case a "leg with no identity
 * is refused" test needs to exercise. Omitted means tom; passed means passed.
 */
async function postVoice(body, ...rest) {
  legFrom(rest.length ? rest[0] : FROM_TOM);
  // Every real Twilio request carries a CallSid, and the identity lookup is
  // keyed on it. Default one so a test only opts out deliberately.
  const withSid = 'CallSid' in body ? body : { CallSid: 'CA1e510000000000000000000000000000', ...body };
  return request(await listenLoopback(app)).post('/api/voice').send(withSid);
}

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
  legFrom(FROM_TOM);
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
    const res = await postVoice({ Action: 'join', ConferenceName: VICTIM_CONF, Muted: 'true' }, FROM_TOM);

    expect(res.statusCode).toBe(403);
    // The point is not merely the status code: no TwiML that could place the
    // caller anywhere may be emitted, and the victim's conference name must not
    // appear in the response at all.
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('a forged ticket is refused', async () => {
    const res = await postVoice({ Action: 'join', ConferenceName: VICTIM_CONF, JoinTicket: 'not-a-real-ticket' }, FROM_TOM);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('an expired ticket is refused', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');
    // Walk the clock past the TTL rather than waiting on it.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + TICKET_TTL_MS + 1);

    const res = await postVoice({ Action: 'join', JoinTicket: ticket }, FROM_TOM);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a ticket whose conference has already ended is refused, not used to conjure an empty one', async () => {
    // Tickets outlive conferences: removeConference runs at normal call end
    // while a ticket minted seconds earlier is still inside its TTL. Twilio
    // creates a conference on demand, so passing a dead name would silently
    // make a NEW empty conference and — with startConferenceOnEnter:false —
    // park the joiner in silence forever.
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');
    removeConference(OWN_CONF);

    const res = await postVoice({ Action: 'join', JoinTicket: ticket }, FROM_TOM);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a refused join raises a system alert — expected volume is zero, so a burst is signal', async () => {
    await postVoice({ Action: 'join', ConferenceName: 'nucleus-call-alert-probe-1' }, FROM_TOM);

    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sendSystemAlert.mock.calls[0][0]).toMatch(/entry refused/i);
  });

  test('repeat refusals for the same conference are throttled, but each one is still logged', async () => {
    // An alert an attacker can trigger on demand is a channel they can flood to
    // bury a real alert. The dull case is likelier: one browser on a
    // pre-deploy bundle firing one 🔴 per retry. Throttling must never lose the
    // EVENT though — only the notification — so the server log is asserted too.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Route through postVoice like every other case. These two were left on the
    // raw request builder during the REST-identity conversion: they carried a
    // vestigial body `From` (which production no longer reads) and NO CallSid,
    // so they refused at identity resolution and never reached the ticket logic
    // they were written to exercise — and passed anyway. A test that stops
    // testing its subject but keeps going green is worse than a deleted one.
    for (let i = 0; i < 3; i += 1) {
      await postVoice({ Action: 'join', ConferenceName: 'nucleus-call-flood' });
    }
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('nucleus-call-flood'))).toHaveLength(3);

    // A DIFFERENT conference is a different signal and must not be suppressed.
    await postVoice({ Action: 'join', ConferenceName: 'nucleus-call-flood-2' });
    expect(sendSystemAlert).toHaveBeenCalledTimes(2);
  });
});

/* ───────── family 1b: a Twilio outage is not an attack ───────── */

// jsec-gsx0 P1. The infrastructure alert plumbing had NO coverage at all —
// deleting it entirely left the suite green, so the only thing tested was the
// boolean coming out of resolveCallerIdentity, never that voice.js uses it.
// The whole justification for that plumbing is operational: during a Twilio REST
// degradation EVERY in-flight call is refused, each on a different conference
// name, so the per-conference alert key would page one "someone is probing"
// alert PER CALL — burying the real signal under noise at the exact moment
// something is genuinely wrong.
describe('POST /api/voice — a Twilio lookup failure alerts ONCE, and says what it is', () => {
  const failLookup = (status) => {
    const err = Object.assign(new Error(`HTTP ${status}`), { status });
    client.calls.mockImplementation(() => ({ fetch: jest.fn().mockRejectedValue(err) }));
  };

  test('two 5xx refusals on DIFFERENT conferences collapse to a single alert', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failLookup(503);
    const server = await listenLoopback(app);

    await request(server).post('/api/voice')
      .send({ CallSid: 'CA' + '1'.repeat(32), ConferenceName: 'nucleus-call-a' });
    await request(server).post('/api/voice')
      .send({ CallSid: 'CA' + '2'.repeat(32), ConferenceName: 'nucleus-call-b' });

    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(sendSystemAlert.mock.calls[0][1]);
    expect(body).toMatch(/INFRASTRUCTURE failure/);
    expect(body).not.toMatch(/someone probing/);
  });

  test('SECURITY: a 429 stays on the per-conference key, so probing cannot hide under the outage banner', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    failLookup(429);
    const server = await listenLoopback(app);

    await request(server).post('/api/voice')
      .send({ CallSid: 'CA' + '3'.repeat(32), ConferenceName: 'nucleus-call-probe-1' });
    await request(server).post('/api/voice')
      .send({ CallSid: 'CA' + '4'.repeat(32), ConferenceName: 'nucleus-call-probe-2' });

    // Two DISTINCT conferences on a non-infrastructure cause => two alerts.
    expect(sendSystemAlert).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(sendSystemAlert.mock.calls[0][1])).not.toMatch(/INFRASTRUCTURE failure/);
  });
});

/* ───────── family 2: the request body cannot steer a valid ticket ───────── */

describe('POST /api/voice Action=join — the ticket, not the request body, names the conference', () => {
  test('a valid ticket joins the conference it was issued for', async () => {
    const ticket = issueJoinTicket(OWN_CONF, false, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket }, FROM_TOM);

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
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket, ConferenceName: VICTIM_CONF }, FROM_TOM);

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('SECURITY: muted comes from the ticket, so a silent-join grant cannot be flipped to an open mic', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket, Muted: 'false' }, FROM_TOM);

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/muted="true"/);
  });

  test('an unmuted grant stays unmuted even if the body asks for muted', async () => {
    const ticket = issueJoinTicket(OWN_CONF, false, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket, Muted: 'true' }, FROM_TOM);

    expect(res.statusCode).toBe(200);
    expect(res.text).toMatch(/muted="false"/);
  });

  test('a ticket is a join-only concept — the initiate path does not use one', async () => {
    createConference('nucleus-call-initiate-1', {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Lead', dbRowId: 1,
    });

    const res = await postVoice({ ConferenceName: 'nucleus-call-initiate-1', CallSid: 'CA00000000000000010000000000000000' }, 'client:kate');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('>nucleus-call-initiate-1</Conference>');
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
  });
});

/* ───────── family 2b: the ticket only works for the caller it was issued to ───────── */

// jsec-gsx0. Pre-binding, the ticket was a bearer token: it transits Twilio and
// sits in Call/Debugger logs for its whole 2-minute TTL, so anyone who could read
// it there — plus a device token, which every authenticated principal can mint
// for themselves — could redeem it. Binding makes possession insufficient.
//
// Safe to enforce because `From` is derived by Twilio from the ACCESS TOKEN, not
// from client-supplied params (see lib/twilio-caller-identity.js for the
// production evidence), unlike the CallerIdentity param the client also sends
// and which would be worthless as a check.
describe('POST /api/voice Action=join — the ticket is bound to a caller (jsec-gsx0)', () => {
  test('SECURITY: a ticket lifted from a Twilio log is useless to another caller', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket }, FROM_ATTACKER);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain(OWN_CONF);
  });

  test('the rightful owner still redeems the same ticket', async () => {
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');

    const res = await postVoice({ Action: 'join', JoinTicket: ticket }, FROM_TOM);

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
  });

  test('SECURITY: a leg with no client identity is refused even holding a valid ticket', async () => {
    // Fail closed. A PSTN leg, or any leg whose From is not client:<identity>,
    // must not redeem — otherwise the identity check is skippable by simply not
    // presenting one.
    const ticket = issueJoinTicket(OWN_CONF, true, 'tom');

    for (const from of ['+16025551234', '', undefined, null]) {
      const res = await postVoice({ CallSid: 'CA0000000000000000000000000000ff00', Action: 'join', JoinTicket: ticket }, from);
      expect(res.statusCode).toBe(403);
      expect(res.text).not.toContain('<Conference');
    }
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

    const res = await postVoice({ ConferenceName: VICTIM_CONF, CallSid: 'CAa77ac6e7000000000000000000000000' }, FROM_ATTACKER);

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

    await postVoice({ ConferenceName: VICTIM_CONF, CallSid: 'CAa77ac6e7000000000000000000000000' }, FROM_ATTACKER);

    const wroteCallerSid = pool.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('SET caller_call_sid')
    );
    expect(wroteCallerSid).toBe(false);
  });

  test('SECURITY: an unknown conference name is refused rather than conjured into existence', async () => {
    // Twilio creates a conference on demand, so an unguarded name is not merely
    // a failed lookup — it is a brand-new conference with the attacker in it.
    const res = await postVoice({ ConferenceName: 'sim-4', CallSid: 'CAa77ac6e7000000000000000000000000' }, FROM_ATTACKER);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('SECURITY (jsec-gsx0): the ~1s window is closed — a NOT-YET-STARTED conference still refuses a stranger', async () => {
    // This is the case jsec-r0k6 could NOT close. Its guard was a lifecycle
    // invariant ("known AND not yet started"), which left a real gap: between
    // createConference and the conference-start callback the conference is known
    // and not started, so an attacker who already knew the name could walk in.
    // Ownership closes it — you must be the rep it was created for, whenever you
    // arrive. Note conferenceSid is deliberately NOT set here: the lifecycle
    // guard would PASS this request, so only the ownership check can refuse it.
    createConference(VICTIM_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 7,
    });

    const res = await postVoice({ ConferenceName: VICTIM_CONF, CallSid: 'CAa77ac6e7000000000000000000000000' }, FROM_ATTACKER);

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain(VICTIM_CONF);
  });

  test('SECURITY (jsec-gsx0): an ownership refusal never reaches the victim\'s DB row either', async () => {
    // The r0k6 DB-row test only exercised the ALREADY-LIVE refusal. Moving the
    // ownership check below the caller_call_sid UPDATE left the full suite green
    // while an attacker still stamped their CallSid onto the victim's row and
    // broke transcription mapping for the real rep. Found by review; pinned here.
    // conferenceSid is deliberately unset so ONLY the ownership check can refuse.
    createConference(VICTIM_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 7,
    });

    await postVoice({ CallSid: 'CAa77ac6e7000000000000000000000000', ConferenceName: VICTIM_CONF }, 'client:blake');

    const wroteCallerSid = pool.query.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('SET caller_call_sid')
    );
    expect(wroteCallerSid).toBe(false);
  });

  test('a display-cased owner still matches — case must not become a silent permanent 403', async () => {
    // Every other fixture seeds a lowercase owner, so dropping .toLowerCase()
    // on startedBy survived the whole suite. If startedBy ever arrives
    // display-cased ('Tom'), that mutation would 403 EVERY outbound call for
    // that rep — a fail-closed outage, which is the exact shape the parser-side
    // case test was written to prevent. This is its startedBy-side twin.
    createConference('nucleus-call-cased-owner', {
      callerIdentity: 'Tom', to: '+16025550003', contactName: 'Lead', dbRowId: 11,
    });

    const res = await postVoice({ CallSid: 'CAca5ed000000000000000000000000f00', ConferenceName: 'nucleus-call-cased-owner' }, 'client:tom');

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('>nucleus-call-cased-owner</Conference>');
    removeConference('nucleus-call-cased-owner');
  });

  test('SECURITY (jsec-gsx0): an ownerless conference refuses everyone on the initiate path', async () => {
    // createConference refuses a missing owner, so this is corruption-only —
    // reproduce it through the real store, as call-ownership-guards.test.js does.
    // Fail CLOSED: '' must not match an empty/absent caller identity.
    createConference(VICTIM_CONF, {
      callerIdentity: 'kate', to: '+16025550001', contactName: 'Real Customer', dbRowId: 7,
    });
    updateConference(VICTIM_CONF, { startedBy: undefined });

    const res = await postVoice({ ConferenceName: VICTIM_CONF, CallSid: 'CA0000000000000000000000000000ff00' }, 'client:kate');

    expect(res.statusCode).toBe(403);
    expect(res.text).not.toContain('<Conference');
  });

  test('a legitimate outbound initiate — known conference, not yet started — still works', async () => {
    // The regression that matters in the other direction: this is the path
    // every real outbound call takes, from the PWA and from the iOS dialer.
    createConference(OWN_CONF, {
      callerIdentity: 'tom', to: '+16025550001', contactName: 'Lead', dbRowId: 2,
    });

    const res = await postVoice({ ConferenceName: OWN_CONF, CallSid: 'CA1e617000000000000000000000000f00' }, FROM_TOM);

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain(`>${OWN_CONF}</Conference>`);
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
    expect(res.text).toContain('<Transcription');
  });

  test('a sim conference behaves the same — allowed before it starts, refused once live', async () => {
    createConference('sim-42', {
      callerIdentity: 'blake', to: null, contactName: 'Mike Garza', dbRowId: 42,
    });

    const before = await postVoice({ ConferenceName: 'sim-42', CallSid: 'CA51a00000000000000000000000000f00' }, 'client:blake');
    expect(before.statusCode).toBe(200);

    updateConference('sim-42', { conferenceSid: 'CFsimlive' });

    const after = await postVoice({ ConferenceName: 'sim-42', CallSid: 'CA127200de000000000000000000000f00' }, 'client:blake');
    expect(after.statusCode).toBe(403);
  });
});
