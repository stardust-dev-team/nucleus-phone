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

    expect(res.text).toContain('<Client>paul</Client>');
    expect(res.text).not.toContain('<Conference');
    expect(conference.createConference).not.toHaveBeenCalled();

    // Hybrid B: server-side audit still fires for iOS routes
    expect(pool.query).toHaveBeenCalled();
    expect(slack.sendSlackAlert).toHaveBeenCalled();
    expect(slack.sendSlackDM).toHaveBeenCalledWith('D-ios', expect.any(String));
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

    expect(res.text).toContain('<Client>kate</Client>');
    expect(res.text).not.toContain('<Conference');
    expect(res.text).not.toContain('+19995551111');
    expect(conference.createConference).not.toHaveBeenCalled();
  });
});

/* ─── (d) Malformed route — server fails to start ─── */

describe('INBOUND_ROUTES validator — boot-time', () => {
  test('exits when a route has neither forward nor iosIdentity', () => {
    process.env.INBOUND_ROUTES = JSON.stringify({
      [PSTN_NUMBER]: { slack: 'D-broken', name: 'Broken' },
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      jest.isolateModules(() => require('../incoming'));
    }).toThrow('process.exit called');

    expect(errSpy).toHaveBeenCalledWith(
      'FATAL: INBOUND_ROUTES is invalid:',
      expect.stringContaining('every route must have'),
    );

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
