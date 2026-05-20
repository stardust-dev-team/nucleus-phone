/**
 * Tests for POST /api/voice/sim-bridge.
 *
 * Architecture B (Vapi-initiated): Vapi dials NUCLEUS_SIM_CONFERENCE_NUMBER
 * → Twilio fires this inbound webhook → we look up the pending sim row via
 * time-window correlation and return TwiML that conferences Vapi's leg into
 * `sim-{id}`.
 *
 * Correlation strategy: option 1 from joruva-dialer-mac-8rx — SELECT FOR
 * UPDATE SKIP LOCKED on the most recent sim row matching:
 *   vapi_call_id IS NOT NULL
 *   conference_sid IS NOT NULL
 *   twilio_vapi_leg_sid IS NULL  -- not yet claimed
 *   status = 'in-progress'
 *   conference_sid_set_at > NOW() - make_interval(secs => $1)
 *
 * Hardening (from Linus pass):
 *   - retry idempotency: same CallSid arriving twice returns the same TwiML
 *   - failure path actively ends the rep's stuck conference
 *   - failure TwiML is bare <Hangup/> — no <Say> (Vapi is the listener)
 *   - rowCount === 1 guard on the claim UPDATE
 */

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

jest.mock('../../lib/twilio', () => {
  const conferences = jest.fn(() => ({
    update: jest.fn().mockResolvedValue({}),
  }));
  // Pull in the real VoiceResponse so the TwiML XML we emit matches Twilio's
  // wire format. Only `client.conferences(...)` is mocked.
  const actual = jest.requireActual('twilio');
  return { client: { conferences }, VoiceResponse: actual.twiml.VoiceResponse };
});

jest.mock('../../lib/slack', () => ({
  sendSystemAlert: jest.fn().mockResolvedValue(true),
  sendSlackAlert: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn() }));
jest.mock('../../lib/health-tracker', () => ({ touch: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { client } = require('../../lib/twilio');
const { sendSystemAlert } = require('../../lib/slack');
const voiceRouter = require('../voice');

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice', voiceRouter);
  process.env.NODE_ENV = 'test'; // disables twilioWebhook signature validation
});

/**
 * Configure pool.connect() to return a mock client whose query() responds
 * to each SQL the handler issues.
 *
 *   idempotencyRows: rows returned by the SELECT-by-CallSid (retry check)
 *   selectRows: rows returned by the FOR UPDATE SKIP LOCKED correlation SELECT
 *   diagRows: rows returned by the diagnostic candidate SELECT (no-match branch)
 *   updateRowCount: rowCount returned by the claim UPDATE
 *   throwOnSelect: if true, the correlation SELECT rejects
 */
function mockTransaction({
  idempotencyRows = [],
  selectRows = [],
  diagRows = [],
  updateRowCount = 1,
  throwOnSelect = false,
} = {}) {
  // The handler issues three SELECTs. Discriminate by SQL shape:
  //   FOR UPDATE SKIP LOCKED → correlation lookup (selectRows)
  //   LIMIT 5                → diagnostic candidate list (diagRows)
  //   otherwise SELECT id    → idempotency check (idempotencyRows)
  const queryMock = jest.fn().mockImplementation((sql) => {
    if (/^BEGIN$/i.test(sql)) return Promise.resolve();
    if (/^COMMIT$/i.test(sql)) return Promise.resolve();
    if (/^ROLLBACK$/i.test(sql)) return Promise.resolve();
    if (/^UPDATE/i.test(sql)) return Promise.resolve({ rows: [], rowCount: updateRowCount });
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) {
      if (throwOnSelect) return Promise.reject(new Error('deadlock'));
      return Promise.resolve({ rows: selectRows });
    }
    if (/LIMIT 5/.test(sql)) return Promise.resolve({ rows: diagRows });
    if (/^SELECT id/i.test(sql)) return Promise.resolve({ rows: idempotencyRows });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const releaseMock = jest.fn();
  pool.connect.mockResolvedValue({ query: queryMock, release: releaseMock });
  return { queryMock, releaseMock };
}

beforeEach(() => {
  jest.clearAllMocks();
});

const send = (body = {}) =>
  request(app)
    .post('/api/voice/sim-bridge')
    .type('form')
    .send({ CallSid: 'CA-vapi-leg-1', From: '+15558675309', To: '+18885550000', ...body });

describe('POST /api/voice/sim-bridge', () => {
  test('happy path: matches pending sim row, claims it, returns conference TwiML with no Say', async () => {
    const { queryMock, releaseMock } = mockTransaction({ selectRows: [{ id: 42 }] });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toMatch(/<Dial>/);
    expect(res.text).toMatch(/<Conference[^>]*>sim-42<\/Conference>/);
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
    expect(res.text).toMatch(/startConferenceOnEnter="true"/);
    expect(res.text).toMatch(/beep="false"/);
    // No <Say> on happy path — Vapi doesn't need TTS.
    expect(res.text).not.toMatch(/<Say>/);

    // Correlation SELECT uses make_interval and FOR UPDATE SKIP LOCKED.
    const correlationCall = queryMock.mock.calls.find(
      (c) => /^SELECT id/i.test(c[0]) && /FOR UPDATE SKIP LOCKED/.test(c[0])
    );
    expect(correlationCall[0]).toMatch(/twilio_vapi_leg_sid IS NULL/);
    expect(correlationCall[0]).toMatch(/make_interval\(secs => \$1\)/);
    expect(correlationCall[1]).toEqual([30]); // numeric, not string

    // Claim UPDATE writes the CallSid.
    const updateCall = queryMock.mock.calls.find((c) => /^UPDATE/i.test(c[0]));
    expect(updateCall[0]).toMatch(/SET twilio_vapi_leg_sid = \$1/);
    expect(updateCall[1]).toEqual(['CA-vapi-leg-1', 42]);

    // Idempotency check ran first (SELECT id BEFORE the FOR UPDATE).
    const allSelectIdCalls = queryMock.mock.calls.filter((c) => /^SELECT id/i.test(c[0]));
    expect(allSelectIdCalls[0][0]).toMatch(/twilio_vapi_leg_sid = \$1/);
    expect(allSelectIdCalls[0][1]).toEqual(['CA-vapi-leg-1']);

    expect(queryMock).toHaveBeenCalledWith('COMMIT');
    expect(queryMock).not.toHaveBeenCalledWith('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
    expect(sendSystemAlert).not.toHaveBeenCalled();
    expect(client.conferences).not.toHaveBeenCalled();
  });

  test('retry idempotency: same CallSid arriving twice returns the same conference TwiML and skips the claim path', async () => {
    // CallSid already claimed row 42 → idempotency check finds it.
    const { queryMock } = mockTransaction({ idempotencyRows: [{ id: 42 }] });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Conference[^>]*>sim-42<\/Conference>/);
    expect(res.text).not.toMatch(/<Say>/);

    // No correlation SELECT, no UPDATE, no diagnostic SELECT — short-circuited.
    const correlationCalls = queryMock.mock.calls.filter(
      (c) => /^SELECT id/i.test(c[0]) && /FOR UPDATE SKIP LOCKED/.test(c[0])
    );
    expect(correlationCalls).toHaveLength(0);
    const updateCalls = queryMock.mock.calls.filter((c) => /^UPDATE/i.test(c[0]));
    expect(updateCalls).toHaveLength(0);

    expect(queryMock).toHaveBeenCalledWith('COMMIT');
    expect(sendSystemAlert).not.toHaveBeenCalled();
  });

  test('no correlatable row, candidates exist outside window: ends stuck conference, alert says "bump the window"', async () => {
    const { queryMock, releaseMock } = mockTransaction({
      selectRows: [],
      diagRows: [{ id: 99, conference_sid: 'CF-stuck-99', conference_sid_set_at: new Date('2026-05-19T20:00:00Z') }],
    });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Hangup\s*\/>/);
    expect(res.text).not.toMatch(/<Conference/);
    expect(res.text).not.toMatch(/<Say>/);

    // No claim UPDATE attempted when no row matched.
    expect(queryMock.mock.calls.filter((c) => /^UPDATE/i.test(c[0]))).toHaveLength(0);
    expect(queryMock).toHaveBeenCalledWith('COMMIT');
    expect(releaseMock).toHaveBeenCalled();

    // Stuck conference cleanup fires.
    expect(client.conferences).toHaveBeenCalledWith('CF-stuck-99');
    const update = client.conferences.mock.results[0].value.update;
    expect(update).toHaveBeenCalledWith({ status: 'completed' });

    // Diagnostic alert distinguishes "outside window" from "none at all".
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    const [title, blocks] = sendSystemAlert.mock.calls[0];
    expect(title).toMatch(/no correlatable row/i);
    expect(blocks[0].text.text).toContain('1 unbridged candidate');
    expect(blocks[0].text.text).toContain('Vapi dial latency exceeded the window');
    expect(blocks[0].text.text).toContain('sim id=99');
  });

  test('no correlatable row, zero candidates: alert says "look upstream", no cleanup attempted', async () => {
    mockTransaction({ selectRows: [], diagRows: [] });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Hangup\s*\/>/);

    // No stuck conference to clean up.
    expect(client.conferences).not.toHaveBeenCalled();

    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    const blocks = sendSystemAlert.mock.calls[0][1];
    expect(blocks[0].text.text).toContain('no unbridged candidates at all');
    expect(blocks[0].text.text).toMatch(/look upstream/i);
  });

  test('DB connect failure: rolls back, hangs up, alerts', async () => {
    pool.connect.mockRejectedValueOnce(new Error('pool exhausted'));

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Hangup\s*\/>/);
    expect(res.text).not.toMatch(/<Say>/);
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sendSystemAlert.mock.calls[0][0]).toMatch(/handler exception/i);
  });

  test('correlation SELECT throws: ROLLBACK runs and connection released', async () => {
    const { queryMock, releaseMock } = mockTransaction({ throwOnSelect: true });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Hangup\s*\/>/);
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseMock).toHaveBeenCalled();
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
  });

  test('claim UPDATE rowCount !== 1: throws to ROLLBACK and alerts', async () => {
    const { queryMock } = mockTransaction({ selectRows: [{ id: 42 }], updateRowCount: 0 });

    const res = await send();

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<Hangup\s*\/>/);
    expect(queryMock).toHaveBeenCalledWith('ROLLBACK');
    expect(queryMock).not.toHaveBeenCalledWith('COMMIT');
    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    expect(sendSystemAlert.mock.calls[0][0]).toMatch(/handler exception/i);
    expect(sendSystemAlert.mock.calls[0][1][0].text.text).toMatch(/claim UPDATE affected 0 rows/);
  });
});
