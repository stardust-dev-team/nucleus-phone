jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/conference', () => ({
  createConference: jest.fn(),
  getConference: jest.fn(),
}));
jest.mock('../../lib/twilio', () => {
  const real = jest.requireActual('twilio');
  return {
    VoiceResponse: real.twiml.VoiceResponse,
    client: { conferences: jest.fn(), calls: jest.fn() },
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

const PSTN_NUMBER = '+16026000188';
const IOS_NUMBER = '+16029050230';
const HYBRID_NUMBER = '+16025550101';

let app;
beforeAll(() => {
  // INBOUND_ROUTES is read at module load — set BEFORE require + cache the app.
  process.env.INBOUND_ROUTES = JSON.stringify({
    [PSTN_NUMBER]: { forward: '+14803630494', slack: 'D-pstn', name: 'Ryann' },
    [IOS_NUMBER]: { iosIdentity: 'paul', slack: 'D-ios', name: 'Paul' },
    [HYBRID_NUMBER]: { forward: '+19995551111', iosIdentity: 'kate', slack: '', name: 'Kate' },
  });
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice/incoming', require('../incoming'));
});

afterAll(() => {
  delete process.env.INBOUND_ROUTES;
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

/* ─── (d) Malformed route — server fails to start ─── */

describe('INBOUND_ROUTES validator — boot-time', () => {
  test('exits when a route has neither forward nor iosIdentity', () => {
    // Save the good config from beforeAll so any future test added below
    // this one (or test reordering via --testNamePattern) sees a sane env.
    const original = process.env.INBOUND_ROUTES;
    process.env.INBOUND_ROUTES = JSON.stringify({
      [PSTN_NUMBER]: { slack: 'D-broken', name: 'Broken' },
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => {
        jest.isolateModules(() => require('../incoming'));
      }).toThrow('process.exit called');

      expect(errSpy).toHaveBeenCalledWith(
        'FATAL: INBOUND_ROUTES is invalid:',
        expect.stringContaining('every route must have'),
      );
    } finally {
      process.env.INBOUND_ROUTES = original;
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
