// joruva-dialer-mac-xft: pure-function test for the Twilio Track →
// typed speaker mapping. The narrow slice that pins the contract iOS
// depends on. joruva-dialer-mac-8vr extends this with a route-level
// integration test at the bottom of the file.
jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/live-analysis', () => ({
  broadcast: jest.fn(),
  attachWebSocket: jest.fn(),
  cleanupCall: jest.fn(),
  getCallEquipment: jest.fn(),
  resetCallEquipment: jest.fn(),
  getCallAirQuality: jest.fn(),
  setCallAirQuality: jest.fn(),
  getConnectionStats: jest.fn(),
}));
jest.mock('../../lib/equipment-pipeline', () => ({
  processEquipmentChunk: jest.fn().mockResolvedValue(),
}));
jest.mock('../../lib/conversation-pipeline', () => ({
  processConversationChunk: jest.fn().mockResolvedValue(),
}));
jest.mock('../../lib/phone-extractor', () => ({
  capturePhones: jest.fn().mockResolvedValue(),
}));
jest.mock('../../lib/call-summarizer', () => ({
  summarizeCall: jest.fn(),
  MIN_TRANSCRIPT_LENGTH: 100,
}));

const { mapSpeaker } = require('../transcription');

describe('mapSpeaker (joruva-dialer-mac-xft)', () => {
  test('outbound_track → agent (the rep speaking)', () => {
    expect(mapSpeaker('outbound_track')).toBe('agent');
  });

  test('inbound_track → customer (the lead speaking)', () => {
    expect(mapSpeaker('inbound_track')).toBe('customer');
  });

  test('both_tracks → unknown (diarization wasn’t set per-chunk)', () => {
    expect(mapSpeaker('both_tracks')).toBe('unknown');
  });

  test('undefined / missing → unknown (Twilio omits Track on some events)', () => {
    expect(mapSpeaker(undefined)).toBe('unknown');
    expect(mapSpeaker(null)).toBe('unknown');
    expect(mapSpeaker('')).toBe('unknown');
  });

  test('iOS TranscriptSpeaker enum values are exactly {agent, customer, unknown}', () => {
    // Pin: any return outside this set will throw DecodingError on iOS.
    // If Twilio adds a new Track variant, add a mapping above; do NOT
    // forward the raw value.
    const valid = new Set(['agent', 'customer', 'unknown']);
    for (const t of ['outbound_track', 'inbound_track', 'both_tracks', undefined, 'future_track_value']) {
      expect(valid.has(mapSpeaker(t))).toBe(true);
    }
  });
});

// joruva-dialer-mac-8vr: Route-level pin of the inbound broadcast
// contract. Phase 2 (axg) gave inbound calls a real Twilio conference;
// Phase 3 flipped iOS `liveAnalysisEnabled=true` for inbound. The thing
// iOS now depends on, end-to-end, is that POST /twilio/transcription:
//   1. Resolves CallSid → conference_name via caller_call_sid.
//   2. Calls broadcast(conference_name, ...) — NOT call.id or some
//      direction-keyed identifier — so iOS's WebSocket subscription
//      (keyed on the same conference_name) receives the chunk.
//   3. Applies mapSpeaker(Track) so the speaker field decodes to iOS's
//      TranscriptSpeaker enum.
//
// If a future change keys broadcasts on call.id, or introduces a
// direction-aware path that bypasses mapSpeaker, this block fails
// loudly. Pure mapSpeaker tests above can't catch either regression
// because they don't exercise the route.
const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { broadcast } = require('../../lib/live-analysis');

describe('POST /twilio/transcription — inbound broadcast contract (joruva-dialer-mac-8vr)', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use('/twilio/transcription', require('../transcription'));
  });

  // mockClear (not mockReset): preserve the mock-pool.js default
  // (`mockResolvedValue({rows:[], rowCount:0})`) so an unexpected
  // 3rd pool.query call (e.g. a future row-level lock or metrics
  // insert in the route) doesn't return `undefined` and crash the
  // destructure silently in fire-and-forget post-work.
  beforeEach(() => {
    broadcast.mockClear();
    pool.query.mockClear();
  });

  // Fixture identifiers are deliberately distinctive — no overlap
  // between conference_name, id, CallSid, and lead_phone. That lets the
  // negative-keying assertions below catch a regression where the route
  // is changed to broadcast on call.id, CallSid, or lead_phone instead
  // of conference_name.
  const CONF_NAME = 'CONF-distinct-xyz-77';
  const CALL_ID = 999;
  const LEAD_PHONE = '+13125550102';

  test('inbound caller chunk: broadcasts on conference_name with speaker=customer', async () => {
    // Inbound call row written by Phase 2 — caller_call_sid resolves
    // to the conference Twilio created for the inbound iOS routing.
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: CALL_ID, conference_name: CONF_NAME, lead_phone: LEAD_PHONE }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await request(app)
      .post('/twilio/transcription')
      .send({ CallSid: 'CA-foo-bar-001', TranscriptionText: 'hello', Track: 'inbound_track' })
      .expect(204);

    // Route responds 204 immediately and runs the broadcast in the
    // same await chain as the DB UPDATE. setImmediate yields to the
    // macrotask queue (one event-loop tick past microtasks), which is
    // enough for the mocked pool.query promises to resolve and the
    // sync broadcast(...) call to land in mock.calls. NOT a microtask
    // flush — if mocks ever go async-with-IO (pg-mem, fixture file
    // reads), bump to a poll loop on broadcast.mock.calls.length.
    await new Promise((r) => setImmediate(r));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(CONF_NAME, {
      type: 'transcript_chunk',
      data: { text: 'hello', speaker: 'customer' },
    });
    // Negative-keying pins (P1, Linus 8vr re-review): the broadcast
    // key must be the conference_name, NOT call.id / CallSid /
    // lead_phone. Any of these would break iOS's WS subscription which
    // is keyed on conference_name.
    const firstArg = broadcast.mock.calls[0][0];
    expect(firstArg).not.toBe(CALL_ID);
    expect(firstArg).not.toBe('CA-foo-bar-001');
    expect(firstArg).not.toBe(LEAD_PHONE);
  });

  test('inbound rep chunk: same conference_name, speaker=agent', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ id: CALL_ID, conference_name: CONF_NAME, lead_phone: LEAD_PHONE }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });

    await request(app)
      .post('/twilio/transcription')
      .send({ CallSid: 'CA-foo-bar-002', TranscriptionText: 'thanks for calling', Track: 'outbound_track' })
      .expect(204);

    await new Promise((r) => setImmediate(r));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(CONF_NAME, {
      type: 'transcript_chunk',
      data: { text: 'thanks for calling', speaker: 'agent' },
    });
    const firstArg = broadcast.mock.calls[0][0];
    expect(firstArg).not.toBe(CALL_ID);
    expect(firstArg).not.toBe('CA-foo-bar-002');
    expect(firstArg).not.toBe(LEAD_PHONE);
  });
});
