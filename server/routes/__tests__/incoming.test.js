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
  return {
    VoiceResponse: real.twiml.VoiceResponse,
    client: {
      conferences: jest.fn(),
      // Phase 2: incoming.js calls `client.calls.create(...)` for the
      // iOS-leg create. Default to resolved so tests that don't override
      // get the success path.
      calls: { create: jest.fn().mockResolvedValue({ sid: 'CAfake' }) },
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
    expect(state).toMatchObject({ direction: 'inbound', repName: 'Paul' });
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

  test('terminates the conference + Slack alert when calls.create throws', async () => {
    twilioClient.calls.create.mockRejectedValueOnce(new Error('twilio down'));
    const updateSpy = jest.fn().mockResolvedValue({});
    twilioClient.conferences.mockReturnValue({ update: updateSpy });

    const res = await request(app)
      .post('/api/voice/incoming')
      .type('form')
      .send({ To: IOS_NUMBER, From: '+14155551212', CallSid: 'CA-ios-conf-2' })
      .expect(200);

    // Caller's TwiML was sent BEFORE the throw — caller is in the
    // conference. We MUST terminate via REST so they don't sit in hold
    // music indefinitely. (The dial-complete action URL is the
    // tertiary safety net if this REST race-fails too.)
    expect(res.text).toContain('<Conference');
    expect(twilioClient.conferences).toHaveBeenCalledWith(
      expect.stringMatching(/^nucleus-inbound-ios-[0-9a-f-]{36}$/),
    );
    expect(updateSpy).toHaveBeenCalledWith({ status: 'completed' });
    // Slack alert fires with diagnostic context.
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
