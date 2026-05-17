// joruva-dialer-mac-lkk: TwiML-shape tests for the outbound iOS-leg
// `endConferenceOnExit: true` flag. Pre-fix the iOS leg leaked the
// conference past iOS hangup (Twilio default `false`), so recordings
// kept running until idle timeout. The setting must stay `true` on this
// path or the bug returns silently — refactor that drops the flag has
// no other test catching it.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');

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
    const res = await request(app)
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-test-1',
        CallSid: 'CA1234567890abcdef',
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
    const res = await request(app)
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-test-2',
        CallSid: 'CA0000000000000001',
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
    const res = await request(app)
      .post('/api/voice')
      .send({
        ConferenceName: 'nucleus-call-djy-1',
        CallSid: 'CA0000000000000djy',
      });

    expect(res.text).toContain('<Transcription');
    expect(res.text).toMatch(/partialResults="false"/);
    // Sanity: track="both_tracks" is preserved — it's per-speaker
    // diarization, not the dedup problem.
    expect(res.text).toMatch(/track="both_tracks"/);
  });

  test('join action does NOT set endConferenceOnExit="true" — secondary participants must not end the conference', async () => {
    const res = await request(app)
      .post('/api/voice')
      .send({
        Action: 'join',
        ConferenceName: 'nucleus-call-test-3',
        Muted: 'false',
      });

    // The `Action: 'join'` branch represents an additional listener
    // joining (not currently used in production but the contract is
    // documented in voice.js:22). Their leaving must NEVER end the
    // conference for everyone else.
    expect(res.text).toContain('<Conference');
    expect(res.text).toMatch(/endConferenceOnExit="false"/);
  });
});
