// joruva-dialer-mac-lkk: TwiML-shape tests for the outbound iOS-leg
// `endConferenceOnExit: true` flag. Pre-fix the iOS leg leaked the
// conference past iOS hangup (Twilio default `false`), so recordings
// kept running until idle timeout. The setting must stay `true` on this
// path or the bug returns silently — refactor that drops the flag has
// no other test catching it.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
// jsec-gsx0: /api/voice establishes the caller from the REST Call resource, so
// these TwiML-shape tests need that lookup mocked. Every conference below is
// owned by 'kate', so the leg is kate's.
jest.mock('../../lib/twilio', () => {
  const actual = jest.requireActual('../../lib/twilio');
  return {
    VoiceResponse: actual.VoiceResponse,
    client: { calls: jest.fn(() => ({ fetch: jest.fn().mockResolvedValue({ from: 'client:kate' }) })) },
  };
});

const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const { issueJoinTicket, _clearJoinTickets } = require('../../lib/join-tickets');
const { createConference, removeConference } = require('../../lib/conference');

// jsec-r0k6: the initiate branch now refuses a conference it does not already
// know about, so these TwiML-shape tests must seed the conference through the
// REAL store the way /api/call/initiate does. Authorization itself is covered
// in voice-join-authz.test.js; these tests remain about TwiML attributes.
const SEEDED = ['nucleus-call-test-1', 'nucleus-call-test-2', 'nucleus-call-djy-1', 'nucleus-call-test-3'];
// jsec-gsx0: /api/voice now requires Twilio's From (client:<identity>) on BOTH
// branches, and the initiate branch requires it to match the conference owner.
// Every conference below is seeded to 'kate', so every request sends kate's leg.


beforeEach(() => {
  for (const name of SEEDED) {
    createConference(name, { callerIdentity: 'kate', to: '+16025550001', contactName: 'Lead', dbRowId: 1 });
  }
});

afterEach(() => {
  _clearJoinTickets();
  for (const name of SEEDED) removeConference(name);
  return closeLoopbackServers();
});
let app;
beforeAll(() => {
  process.env.NUCLEUS_PHONE_NUMBER = '+15555550100';
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/voice', require('../voice'));
});

afterAll(() => {
  delete process.env.NUCLEUS_PHONE_NUMBER;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('POST /api/voice — outbound iOS-leg TwiML (joruva-dialer-mac-lkk)', () => {
  test('initiate path emits endConferenceOnExit="true" so iOS hangup terminates the conference', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-test-1',
        CallSid: 'CA1234567890abcdef0000000000000f00',
      });

    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('<Conference');
    // The exact attribute string Twilio emits — pin the flag, not the
    // boolean value alone, so a future refactor that switches to
    // `endConferenceOnExit="false"` (or drops the attribute entirely,
    // restoring the Twilio default of false) regresses loudly.
    expect(res.text).toMatch(/endConferenceOnExit="true"/);
  });

  test('initiate path also sets startConferenceOnEnter="true" — sanity check on related flags', async () => {
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-test-2',
        CallSid: 'CA0000000000000001000000000000ff00',
      });

    expect(res.text).toMatch(/startConferenceOnEnter="true"/);
  });

  test('initiate path emits partialResults="false" (joruva-dialer-mac-djy)', async () => {
    // bd-djy: Twilio RT Transcription with partialResults=true emits
    // every running-text fragment as a separate webhook ("A." → "A lot."
    // → "A lot of." → …). The server broadcasts each fragment; iOS
    // appends every one, rendering the same utterance multiple times
    // with progressive expansion until the transcript is unreadable.
    // partialResults=false makes Twilio buffer until utterance is
    // complete and emit one webhook per finalized chunk per speaker leg.
    //
    // Pin the attribute on the TwiML so any refactor that drops the
    // explicit `partialResults: false` (Twilio's default would matter
    // here too — confirm via Twilio SDK source) trips this assertion.
    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-djy-1',
        CallSid: 'CA0000000000000d1a0000000000000f00',
      });

    expect(res.text).toContain('<Transcription');
    expect(res.text).toMatch(/partialResults="false"/);
    // Sanity: track="both_tracks" is preserved — it's per-speaker
    // diarization, not the dedup problem.
    expect(res.text).toMatch(/track="both_tracks"/);
  });

  test('join action does NOT set endConferenceOnExit="true" — secondary participants must not end the conference', async () => {
    // jsec-r0k6: this test used to send a bare ConferenceName, because the
    // join branch accepted one from anybody. It no longer does — the
    // conference is resolved from a server-minted ticket. Issuing a real
    // ticket here keeps this test about the flag it was written to pin
    // (endConferenceOnExit) rather than silently turning into a second copy
    // of the authorization tests in voice-join-authz.test.js.
    const ticket = issueJoinTicket('nucleus-call-test-3', false, 'kate');

    const res = await request(await listenLoopback(app))
      .post('/api/voice')
      .send({ CallSid: 'CA101a0000000000000000000000000f00', Action: 'join', JoinTicket: ticket });

    // The `Action: 'join'` branch represents an additional listener
    // joining. Their leaving must NEVER end the conference for everyone else.
    expect(res.text).toContain('<Conference');
    expect(res.text).toMatch(/endConferenceOnExit="false"/);
  });
});
