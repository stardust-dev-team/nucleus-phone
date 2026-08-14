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
jest.mock('../../lib/equipment-pipeline', () => ({ processEquipmentChunk: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/conversation-pipeline', () => ({ processConversationChunk: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/phone-extractor', () => ({ capturePhones: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/call-summarizer', () => ({ summarizeCall: jest.fn(), MIN_TRANSCRIPT_LENGTH: 50 }));

// joruva-dialer-mac-xft: pure-function test for the Twilio Track →
// typed speaker mapping. The route as a whole has no unit-test coverage
// yet; this is the narrow slice that pins the contract iOS depends on.
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

// joruva-dialer-mac-8vr: route-level pin of the INBOUND broadcast contract.
// Phase 2 gave inbound calls a real Twilio conference; Phase 3 turned on iOS
// liveAnalysisEnabled for inbound. What iOS now depends on end-to-end is that
// POST /api/transcription:
//   1. resolves CallSid -> conference_name via caller_call_sid (asserted on the SQL itself —
//      mock-pool ignores query text, so only an explicit assertion pins it),
//   2. broadcasts on conference_name — NOT call.id or any direction-keyed id —
//      because the iOS WebSocket subscription is keyed on conference_name,
//   3. applies mapSpeaker(Track) so `speaker` decodes to iOS's enum.
// The pure mapSpeaker tests above cannot catch either regression: they never
// exercise the route.
const request = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');
const express = require('express');
const { pool } = require('../../db');
const { broadcast } = require('../../lib/live-analysis');

describe('POST /api/transcription — inbound broadcast contract (joruva-dialer-mac-8vr)', () => {
  let app;
  let server;

  beforeAll(async () => {
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use('/api/transcription', require('../transcription'));
    // jsec-kh7h: listenLoopback, never a bare Express app — a bare listen(0) binds the IPv6
    // wildcard and the tripwire setup file refuses it.
    server = await listenLoopback(app);
  });

  afterAll(closeLoopbackServers);

  // mockClear, not mockReset: preserve mock-pool's default resolved value so an unexpected
  // third pool.query (a future metrics insert, say) returns a shape rather than undefined and
  // crashing a destructure inside fire-and-forget post-work.
  beforeEach(() => {
    broadcast.mockClear();
    pool.query.mockClear();
  });

  // Deliberately distinctive fixtures, no overlap between the four identifiers, so the
  // negative-keying assertions below can actually catch a regression that broadcasts on
  // call.id / CallSid / lead_phone instead of conference_name.
  const CONF_NAME = 'CONF-distinct-xyz-77';
  const CALL_ID = 999;
  const LEAD_PHONE = '+13125550102';

  const seedRow = () => pool.query
    .mockResolvedValueOnce({ rows: [{ id: CALL_ID, conference_name: CONF_NAME, lead_phone: LEAD_PHONE }] })
    .mockResolvedValueOnce({ rowCount: 1 });

  // The route answers 204 immediately and finishes its work in the same await chain.
  // setImmediate yields one macrotask — past microtasks — which is enough for the mocked
  // pool.query promises to settle and the synchronous broadcast() to land in mock.calls.
  // If these mocks ever do real async IO, replace this with a poll on mock.calls.length.
  const settle = () => new Promise((r) => setImmediate(r));

  test('inbound CALLER chunk broadcasts on conference_name with speaker=customer', async () => {
    seedRow();

    await request(server)
      .post('/api/transcription')
      .type('form')
      .send({ CallSid: 'CA-foo-bar-001', TranscriptionText: 'hello', Track: 'inbound_track' })
      .expect(204);
    await settle();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(CONF_NAME, {
      type: 'transcript_chunk',
      data: { text: 'hello', speaker: 'customer' },
    });
    // The route must resolve the row by caller_call_sid. Nothing else pinned this: mock-pool
    // ignores SQL text entirely, so changing the lookup to `WHERE conference_name = $1` — which
    // would kill live transcription outright, since the webhook only ever supplies a CallSid —
    // left the whole file green.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/caller_call_sid\s*=\s*\$1/);
    expect(params).toEqual(['CA-foo-bar-001']);
  });

  test('inbound REP chunk uses the same conference_name with speaker=agent', async () => {
    seedRow();

    await request(server)
      .post('/api/transcription')
      .type('form')
      .send({ CallSid: 'CA-foo-bar-002', TranscriptionText: 'thanks for calling', Track: 'outbound_track' })
      .expect(204);
    await settle();

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(CONF_NAME, {
      type: 'transcript_chunk',
      data: { text: 'thanks for calling', speaker: 'agent' },
    });
  });
});
