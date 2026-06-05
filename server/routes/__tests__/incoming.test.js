// Parametric TwiML-branch tests for incoming.js. Mocks team-registry to
// return fixture routes per test — the real registry is exercised by
// team-registry.conformance.test.js (schema + drift sentinels).
//
// Schema decision: each route object has the SAME shape that
// team-registry.getAllInboundRoutes() returns:
//   { name, slack, forward? | iosIdentity? }
// If iosIdentity is set, the iOS Client branch fires; if only forward,
// the PSTN/conference branch fires; if both are set, iosIdentity wins
// (per documented preference).

// jest.mock factories run BEFORE any const declarations at module scope
// (Babel hoisting), so the fixture must be defined inside the factory.
// The constants below are also redeclared at the top of the file for
// readability in the test bodies — they're identical to the factory's.
jest.mock('../../lib/team-registry', () => {
  const fakeRegistry = {
    reps: [],
    getRepByIdentity: () => null,
    getRepByDID: () => null,
    getAllInboundRoutes: () => ({
      '+16026000188': { forward: '+14803630494', slack: 'D-pstn', name: 'Ryann' },
      '+16029050230': { iosIdentity: 'paul', slack: 'D-ios', name: 'Paul' },
      '+16025550101': { forward: '+19995551111', iosIdentity: 'kate', slack: '', name: 'Kate' },
    }),
    getInboundRoute: () => null,
  };
  return {
    loadRegistry: jest.fn(() => fakeRegistry),
    loadRegistryOrExit: jest.fn(() => fakeRegistry),
    _resetForTesting: jest.fn(),
  };
});

const PSTN_NUMBER = '+16026000188';
const IOS_NUMBER = '+16029050230';
const HYBRID_NUMBER = '+16025550101';

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  getConference: jest.fn(),
}));
jest.mock('../../lib/twilio', () => {
  const real = jest.requireActual('twilio');
  // `client.calls` is a callable AND a namespace:
  //   - `client.calls.create({...})`     — REST-initiate the iOS leg (Phase 2)
  //   - `client.calls(sid).update({...})` — redirect a caller leg to voicemail
  //                                         TwiML (Phase 2 calls.create failure path)
  // Default to a no-op update spy; tests assign per-test spies when they
  // need to assert on update args.
  const callsMock = jest.fn(() => ({ update: jest.fn().mockResolvedValue({}) }));
  callsMock.create = jest.fn().mockResolvedValue({ sid: 'CAfake' });
  return {
    VoiceResponse: real.twiml.VoiceResponse,
    client: {
      conferences: jest.fn(),
      calls: callsMock,
    },
  };
});
jest.mock('../../lib/slack', () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(true),
  sendSlackDM: jest.fn().mockResolvedValue(true),
}));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const conference = require('../../lib/conference');
const slack = require('../../lib/slack');
const { client: twilioClient } = require('../../lib/twilio');

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice/incoming', require('../incoming'));
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
});

/* ─── (a) Legacy forward-only route — PSTN/conference path unchanged ─── */

describe('POST /api/voice/incoming — legacy forward route', () => {
  test('uses <Conference> TwiML and registers conference state', async () => {
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: PSTN_NUMBER, From: '+14155551212', CallSid: 'CA-pstn-1' })
      .expect(200);

    expect(res.text).toContain('<Conference');
    expect(res.text).not.toContain('<Client>');
    expect(conference.createConference).toHaveBeenCalledTimes(1);
    const [, state] = conference.createConference.mock.calls[0];
    expect(state).toMatchObject({ to: '+14803630494', direction: 'inbound', repName: 'Ryann' });

    // INSERT shape: catches column drift, table renames, lost CallSid/phone
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO nucleus_phone_calls/);
    expect(params).toEqual([
      expect.stringMatching(/^nucleus-inbound-[0-9a-f-]{36}$/),
      'inbound',
      'CA-pstn-1',
      '+14155551212',
    ]);
  });
});

/* ─── (b) iOS-only route — <Client> TwiML, no conference ─── */

describe('POST /api/voice/incoming — iOS-only route', () => {
  test('uses <Client> TwiML and skips createConference', async () => {
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-1' })
      .expect(200);

    // <Client> wraps a <Parameter name="call_id" .../> child (dialer-mac
    // bd-upq.17) so the iOS dialer can map the inbound CallInvite back to
    // the DB row for Phase G's DispositionSheet. Pin the structure with a
    // regex rather than two open-ended substring matches; a stray
    // </Client> from a different <Dial> block elsewhere in the output
    // would silently pass under substring assertions.
    expect(res.text).toMatch(/<Client>paul<Parameter name="call_id" value="\d+"\/><\/Client>/);
    expect(res.text).not.toContain('<Conference');
    expect(conference.createConference).not.toHaveBeenCalled();

    // Hybrid B: INSERT must hit nucleus_phone_calls with iOS-prefixed conf
    // name, direction='inbound', and the actual CallSid/phone — not a
    // half-populated row that a future bug could let slip through.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO nucleus_phone_calls/);
    expect(params).toEqual([
      expect.stringMatching(/^nucleus-inbound-ios-[0-9a-f-]{36}$/),
      'inbound',
      'CA-ios-1',
      '+14155551212',
    ]);
    expect(slack.sendSlackAlert).toHaveBeenCalled();
    expect(slack.sendSlackDM).toHaveBeenCalledWith('D-ios', expect.any(String));
  });

  test('call_id Parameter carries the inserted DB row id (not a hardcoded value)', async () => {
    // Stub the INSERT to return a non-default id so we know the param
    // tracks the actual returned id rather than coincidentally matching
    // the default mock value.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 4242 }], rowCount: 1 });

    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-2' })
      .expect(200);

    expect(res.text).toContain('<Parameter name="call_id" value="4242"/>');
  });
});

/* ─── (b.1) dial-complete records final status + duration (bv33) ─── */

describe('POST /api/voice/incoming/dial-complete — status/duration (bv33)', () => {
  test('DialCallStatus=completed → UPDATE status=completed + duration, guarded on connecting', async () => {
    await request(app)
      .post('/api/voice/incoming/dial-complete?conf=nucleus-inbound-ios-abc&from=%2B14155551212')
      .type('form')
      .send({ DialCallStatus: 'completed', DialCallDuration: '42' })
      .expect(200);

    const updateCall = pool.query.mock.calls.find(([sql]) => /UPDATE nucleus_phone_calls/.test(sql));
    expect(updateCall).toBeDefined();
    const [sql, params] = updateCall;
    expect(sql).toMatch(/SET status = \$1, duration_seconds = \$2/);
    expect(sql).toMatch(/WHERE conference_name = \$3 AND status = 'connecting'/);
    expect(params).toEqual(['completed', 42, 'nucleus-inbound-ios-abc']);
  });

  test('DialCallStatus=no-answer → UPDATE status=missed + duration 0', async () => {
    await request(app)
      .post('/api/voice/incoming/dial-complete?conf=nucleus-inbound-ios-xyz&from=%2B14155551212')
      .type('form')
      .send({ DialCallStatus: 'no-answer' })
      .expect(200);

    const updateCall = pool.query.mock.calls.find(([sql]) => /UPDATE nucleus_phone_calls/.test(sql));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toEqual(['missed', 0, 'nucleus-inbound-ios-xyz']);
  });
});

/* ─── (b.2) iOS route with INBOUND_CONFERENCE_ARCHITECTURE=true ─── */

describe('POST /api/voice/incoming — iOS route, conference architecture flag ON', () => {
  beforeEach(() => {
    process.env.INBOUND_CONFERENCE_ARCHITECTURE = 'true';
    process.env.NUCLEUS_PHONE_NUMBER = '+15555550100';
    twilioClient.calls.create.mockResolvedValue({ sid: 'CAfake' });
    twilioClient.conferences.mockReturnValue({
      update: jest.fn().mockResolvedValue({}),
    });
  });
  afterEach(() => {
    delete process.env.INBOUND_CONFERENCE_ARCHITECTURE;
    delete process.env.NUCLEUS_PHONE_NUMBER;
  });

  test('emits <Conference> caller TwiML and fires calls.create to client:identity', async () => {
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-conf-1' })
      .expect(200);

    // Caller TwiML: <Conference>, NOT <Client>. <Dial> still has the
    // dial-complete action URL for the voicemail-fallback path.
    expect(res.text).toContain('<Conference');
    expect(res.text).not.toContain('<Client>');
    expect(res.text).toMatch(/endConferenceOnExit="false"/);
    expect(res.text).toMatch(/action=".*incoming\/dial-complete/);
    // Conference state is registered for the flywheel.
    expect(conference.createConference).toHaveBeenCalledTimes(1);
    const [confName, state] = conference.createConference.mock.calls[0];
    expect(confName).toMatch(/^nucleus-inbound-ios-[0-9a-f-]{36}$/);
    // callerIdentity MUST be the rep's iOS identity (NOT the literal
    // string 'inbound') so call.js:310-313 auth lets iOS tear down via
    // POST /api/call/end. Without this, the iOS-side endCall would 403
    // (P0-1 from Linus review). Pin both fields to prevent regression.
    expect(state).toMatchObject({
      direction: 'inbound',
      repName: 'Paul',
      callerIdentity: 'paul',
    });
    // iOS-leg REST create fires with the correct join URL + customParameters
    // attached via `to:` query string. These params become PushKit
    // `twi_params` → iOS `TVOCallInvite.customParameters`. The TwiML URL
    // (fetched post-accept) does NOT carry customParameters.
    expect(twilioClient.calls.create).toHaveBeenCalledTimes(1);
    const createArgs = twilioClient.calls.create.mock.calls[0][0];
    expect(createArgs.to).toMatch(/^client:paul\?/);
    expect(createArgs.to).toContain(`conference_name=${encodeURIComponent(confName)}`);
    expect(createArgs.to).toContain('call_id=');
    expect(createArgs.to).toContain('caller_phone=');
    expect(createArgs.from).toBe('+15555550100');
    expect(createArgs.url).toMatch(/\/api\/voice\/inbound-conference-join/);
    expect(createArgs.url).toContain(`conference=${encodeURIComponent(confName)}`);
  });

  test('pins timeout + statusCallback on calls.create (Linus R4 P1-1 + P1-2)', async () => {
    // P1-1: Twilio's default ring is ~60s but the caller's <Dial
    // timeout=35> gives up at 35s. Without explicit `timeout`, t=35..60s
    // window where caller hits voicemail TwiML but rep can still accept
    // → bridges into empty conference → empty recording. Pin
    // timeout: 25 (matches PSTN's rep ring budget; the 35s caller <Dial>
    // remains as belt-and-suspenders).
    //
    // P1-2: Without statusCallback, no-answer detection relies only on
    // the 35s <Dial> action URL — slower than PSTN's 25s rep-status
    // redirect. Pin that the iOS leg's statusCallback targets
    // /api/voice/incoming/rep-status with the conference name so the
    // existing rep-status handler's noAnswer arm fires its voicemail
    // redirect cleanly.
    //
    // statusCallbackEvent is `['completed']` only (NOT 'ringing answered
    // completed'). The in-progress arm in rep-status would no-op for
    // Phase 2 — the iOS-leg join TwiML at voice.js:257 already sets
    // endConferenceOnExit:true, AND at the `answered` event the iOS leg
    // hasn't joined the conference yet (join is post-fetch of the
    // join-URL TwiML), so participants(CallSid).update() would 404.
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-conf-statuscb' })
      .expect(200);
    expect(res.status).toBe(200);

    const createArgs = twilioClient.calls.create.mock.calls[0][0];

    // P1-1: explicit timeout (NOT Twilio's 60s default).
    expect(createArgs.timeout).toBe(25);

    // P1-2: statusCallback to rep-status with the conference name so the
    // existing noAnswer arm can find the caller_call_sid in the DB.
    expect(createArgs.statusCallback).toMatch(/\/api\/voice\/incoming\/rep-status/);
    expect(createArgs.statusCallback).toContain('conf=');

    const confMatch = /conf=([^&]+)/.exec(createArgs.statusCallback);
    expect(confMatch).not.toBeNull();
    const callbackConfName = decodeURIComponent(confMatch[1]);
    expect(callbackConfName).toMatch(/^nucleus-inbound-ios-[0-9a-f-]{36}$/);

    // Only `completed` events — see comment above for why the
    // in-progress arm is deliberately not fired for Phase 2.
    expect(createArgs.statusCallbackEvent).toEqual(['completed']);
    expect(createArgs.statusCallbackMethod).toBe('POST');
  });

  test('redirects caller to voicemail TwiML + Slack alert when calls.create throws (Linus P2-1)', async () => {
    twilioClient.calls.create.mockRejectedValueOnce(new Error('twilio down'));
    // Linus P2-1: previously this path terminated the conference via REST,
    // which left `DialCallStatus=completed` → `dial-complete` returned
    // `<Hangup/>` → caller heard a drop, not voicemail. The redirect
    // pattern (mirrors rep-status's no-answer branch at line ~556) replaces
    // the caller's TwiML mid-call so they hear `appendVoicemailTwiml` and
    // can leave a message.
    const updateSpy = jest.fn().mockResolvedValue({});
    twilioClient.calls.mockReturnValueOnce({ update: updateSpy });

    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-conf-2' })
      .expect(200);

    // Caller's TwiML was sent BEFORE the throw — caller is in the conference.
    expect(res.text).toContain('<Conference');
    // The redirect must target the caller's own CallSid (NOT the iOS leg's),
    // pointing at the voicemail TwiML endpoint with `from` + `conf` params
    // so `appendVoicemailTwiml` produces a recordingStatusCallback that
    // updates the right nucleus_phone_calls row.
    expect(twilioClient.calls).toHaveBeenCalledWith('CA-ios-conf-2');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const updateArgs = updateSpy.mock.calls[0][0];
    expect(updateArgs.method).toBe('POST');
    expect(updateArgs.url).toMatch(/\/api\/voice\/incoming\/voicemail\?from=.+&conf=nucleus-inbound-ios-/);
    // Slack alert fires with diagnostic context for ops.
    const alertCalls = slack.sendSlackAlert.mock.calls.map(c => c[0].text);
    expect(alertCalls.some(t => /conference join failed/.test(t))).toBe(true);
  });

  test('calls.create throws + voicemail redirect itself fails → logs error, does not crash', async () => {
    // Edge case: even the salvage redirect can fail (Twilio fully down).
    // The handler must swallow the secondary error so the request
    // doesn't 500 — caller is already on the line and we can't recover.
    twilioClient.calls.create.mockRejectedValueOnce(new Error('twilio down'));
    const updateSpy = jest.fn().mockRejectedValue(new Error('still down'));
    twilioClient.calls.mockReturnValueOnce({ update: updateSpy });

    await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-conf-3' })
      .expect(200);

    expect(updateSpy).toHaveBeenCalled();
    // Slack alert still fires for the primary failure.
    const alertCalls = slack.sendSlackAlert.mock.calls.map(c => c[0].text);
    expect(alertCalls.some(t => /conference join failed/.test(t))).toBe(true);
  });
});

/* ─── (b.3) Flag-off rollback safety: legacy <Client> path stays default ─── */

describe('POST /api/voice/incoming — iOS route, conference flag unset (rollback)', () => {
  beforeEach(() => {
    // Explicitly delete to assert the unset semantics — not 'false', but absent.
    delete process.env.INBOUND_CONFERENCE_ARCHITECTURE;
  });

  test('unset flag falls back to legacy <Client> branch — calls.create NOT fired', async () => {
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-legacy-1' })
      .expect(200);

    expect(res.text).toMatch(/<Client>paul<Parameter name="call_id" value="\d+"\/><\/Client>/);
    expect(res.text).not.toContain('<Conference');
    expect(twilioClient.calls.create).not.toHaveBeenCalled();
    expect(conference.createConference).not.toHaveBeenCalled();
  });

  test('flag set to "false" string also falls back to legacy <Client> branch', async () => {
    process.env.INBOUND_CONFERENCE_ARCHITECTURE = 'false';
    try {
      const res = await request(app)
        .post('/api/voice/incoming')
        .type('form')
        .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-legacy-2' })
        .expect(200);

      expect(res.text).toContain('<Client>');
      expect(twilioClient.calls.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.INBOUND_CONFERENCE_ARCHITECTURE;
    }
  });
});

/* ─── (c) Hybrid route with both fields — iosIdentity wins ─── */

describe('POST /api/voice/incoming — hybrid route', () => {
  test('iosIdentity wins over forward when both are present', async () => {
    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: HYBRID_NUMBER, From: '+14155551212', CallSid: 'CA-hyb-1' })
      .expect(200);

    // Hybrid route also emits the call_id <Parameter> child since it
    // routes through the iOS branch.
    expect(res.text).toMatch(/<Client>kate<Parameter name="call_id" value="\d+"\/><\/Client>/);
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain('+19995551111');
    expect(conference.createConference).not.toHaveBeenCalled();
  });
});

/* ─── (b.4) Phase 2 boot guard: NUCLEUS_PHONE_NUMBER required for iOS routes ─── */

describe('incoming.js boot — NUCLEUS_PHONE_NUMBER guard (Linus P1-2, R2 P1-A)', () => {
  // Shared snapshot helper — every test in this block must restore
  // both env vars to whatever the CI runner had set, otherwise one
  // test mutating env leaks into subsequent tests in the file.
  const snapshotEnv = () => ({
    phone: process.env.NUCLEUS_PHONE_NUMBER,
    flag: process.env.INBOUND_CONFERENCE_ARCHITECTURE,
  });
  const restoreEnv = (snap) => {
    if (snap.phone !== undefined) process.env.NUCLEUS_PHONE_NUMBER = snap.phone;
    else delete process.env.NUCLEUS_PHONE_NUMBER;
    if (snap.flag !== undefined) process.env.INBOUND_CONFERENCE_ARCHITECTURE = snap.flag;
    else delete process.env.INBOUND_CONFERENCE_ARCHITECTURE;
  };

  test('process.exit(1) when Phase 2 enabled + iOS route exists + NUCLEUS_PHONE_NUMBER unset', () => {
    // The default jest mock's fixture HAS an iOS route (paul on
    // IOS_NUMBER), so loading incoming.js fresh with the flag ON but
    // NUCLEUS_PHONE_NUMBER unset must exit. Pre-fix, the module loaded
    // fine and the runtime fallback `from: callerPhone` would 21210 on
    // every Phase 2 call.
    const snap = snapshotEnv();
    jest.resetModules();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.INBOUND_CONFERENCE_ARCHITECTURE = 'true';
    delete process.env.NUCLEUS_PHONE_NUMBER;
    try {
      expect(() => require('../incoming')).toThrow('process.exit called');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('NUCLEUS_PHONE_NUMBER is not configured'),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      restoreEnv(snap);
    }
  });

  test('R2 P1-A: boot SUCCEEDS when Phase 2 is OFF (rollback path) even with iOS routes + no NUCLEUS_PHONE_NUMBER', () => {
    // Critical rollback assertion: when INBOUND_CONFERENCE_ARCHITECTURE
    // is unset/false, the iOS route uses the legacy <Client> TwiML path
    // which never touches `client.calls.create({from: ...})`. Requiring
    // NUCLEUS_PHONE_NUMBER in this case would break the rollback knob:
    // flipping Phase 2 off as an emergency mitigation would also need a
    // separate env-var set. Pin the predicate so a regression that
    // drops the flag check fails CI.
    const snap = snapshotEnv();
    jest.resetModules();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called (rollback regression)');
    });
    delete process.env.INBOUND_CONFERENCE_ARCHITECTURE;
    delete process.env.NUCLEUS_PHONE_NUMBER;
    try {
      expect(() => require('../incoming')).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      restoreEnv(snap);
    }
  });

  test('boot succeeds when Phase 2 enabled AND NUCLEUS_PHONE_NUMBER is set', () => {
    // The configured-correctly happy path. Wrap with exitSpy (R2 N7):
    // a regression making the guard exit despite valid config would
    // otherwise crash the Jest worker instead of failing the test.
    const snap = snapshotEnv();
    jest.resetModules();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called unexpectedly');
    });
    process.env.INBOUND_CONFERENCE_ARCHITECTURE = 'true';
    process.env.NUCLEUS_PHONE_NUMBER = '+15555550100';
    try {
      expect(() => require('../incoming')).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      restoreEnv(snap);
    }
  });
});

/* ─── (d) team-registry load fails — server fails to start ─── */

describe('incoming.js boot — registry load failure', () => {
  test('process.exit(1) when loadRegistryOrExit throws on load', () => {
    // Reset the module cache + re-mock team-registry so loadRegistryOrExit
    // calls process.exit(1) this time. The file-level jest.mock returns a
    // working fixture; we override here for the validator-fail path.
    // jest.resetModules() forces incoming.js to re-evaluate its module-init
    // block with the throwing mock active.
    jest.resetModules();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    jest.doMock('../../lib/team-registry', () => ({
      loadRegistry: jest.fn(() => {
        throw new Error('team-registry: every rep must have a valid inbound entry');
      }),
      loadRegistryOrExit: jest.fn(() => {
        // Mirror the real loadRegistryOrExit: log FATAL then process.exit.
        // (Direct require of '../team-registry' inside the mock would
        // recursively hit jest.doMock — easier to inline the contract here.)
        console.error(
          'FATAL: team-registry load failed (consumer=incoming):',
          'team-registry: every rep must have a valid inbound entry',
        );
        process.exit(1);
      }),
      _resetForTesting: jest.fn(),
    }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => require('../incoming')).toThrow('process.exit called');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('FATAL: team-registry load failed'),
        expect.stringContaining('every rep must have'),
      );
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      jest.dontMock('../../lib/team-registry');
    }
  });
});
