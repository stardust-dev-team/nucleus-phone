// Cross-route equivalence proof (nucleus-phone-rgja.7, deferred from Stage A's Linus
// review). Stage A unit-tested the shared transcript-ingest module; this drives BOTH
// real routes end-to-end — /api/transcription (Twilio webhook body) and /api/stt-ingest
// (in-house JSON body) — through the REAL transcript-ingest (only the leaf collaborators
// are mocked) and asserts the downstream fan-out is IDENTICAL. That equivalence is the
// whole safety case for the STT swap: the dialer + every pipeline can't tell the sources
// apart, except for the recorded transcript_source.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../../lib/live-analysis', () => ({ broadcast: jest.fn() }));
jest.mock('../../lib/equipment-pipeline', () => ({ processEquipmentChunk: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/conversation-pipeline', () => ({ processConversationChunk: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/phone-extractor', () => ({ capturePhones: jest.fn().mockResolvedValue() }));
jest.mock('../../lib/call-summarizer', () => ({ summarizeCall: jest.fn(), MIN_TRANSCRIPT_LENGTH: 50 }));
jest.mock('../../lib/inflight', () => ({ track: (p) => p }));
jest.mock('../../lib/health-tracker', () => ({ touch: jest.fn() }));
jest.mock('../../lib/debug-log', () => ({ logEvent: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { pool } = require('../../db');
const { broadcast } = require('../../lib/live-analysis');
const { processEquipmentChunk } = require('../../lib/equipment-pipeline');
const { processConversationChunk } = require('../../lib/conversation-pipeline');
const { capturePhones } = require('../../lib/phone-extractor');

const CONF = 'nucleus-call-abc';
const SECRET = 'test-stt-secret';
// Same id/conference/lead_phone on both rows — the ONLY difference is the gate, which
// flips which route is the DRIVER (Twilio drives when false; in-house drives when true).
const ROW = { id: 7, conference_name: CONF, lead_phone: '+16025551212' };

// SELECT by caller_call_sid → the Twilio-driven row; SELECT by conference_name → the
// in-house-driven row; anything else (the accumulate UPDATE) → empty ok.
function installPool() {
  pool.query.mockImplementation((sql) => {
    if (/SELECT/i.test(sql) && /caller_call_sid/.test(sql)) {
      return Promise.resolve({ rows: [{ ...ROW, use_inhouse_stt: false }] });
    }
    if (/SELECT/i.test(sql) && /conference_name/.test(sql)) {
      return Promise.resolve({ rows: [{ ...ROW, use_inhouse_stt: true }] });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

let app;
beforeAll(() => {
  app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/api/transcription', require('../transcription'));
  app.use('/api/stt-ingest', require('../stt-ingest'));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STT_INGEST_SECRET = SECRET;
  installPool();
});

// The Twilio route acks 204 BEFORE awaiting the ingest, so let the post-response
// microtask/await chain settle before reading the collaborator spies.
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

function snapshot() {
  return {
    broadcast: broadcast.mock.calls[0],
    equip: processEquipmentChunk.mock.calls[0],
    conv: processConversationChunk.mock.calls[0],
    phones: capturePhones.mock.calls[0],
  };
}

test('Twilio webhook and in-house ingest produce IDENTICAL downstream fan-out', async () => {
  // Twilio path (drives because use_inhouse_stt=false): outbound_track → agent.
  await request(app)
    .post('/api/transcription')
    .type('form')
    .send({ TranscriptionText: 'same words', Track: 'outbound_track', CallSid: 'CA1' })
    .expect(204);
  await flush();
  const twilio = snapshot();

  jest.clearAllMocks();
  installPool();

  // In-house path (drives because use_inhouse_stt=true): speaker already 'agent'.
  await request(app)
    .post('/api/stt-ingest')
    .set('authorization', `Bearer ${SECRET}`)
    .send({ conferenceName: CONF, text: 'same words', speaker: 'agent', isFinal: true, uttStartMs: 0, uttEndMs: 800 })
    .expect(204);
  await flush();
  const inhouse = snapshot();

  // Every downstream collaborator was called identically — the safety proof.
  expect(twilio.broadcast).toBeDefined();
  expect(inhouse.broadcast).toEqual(twilio.broadcast);
  expect(inhouse.equip).toEqual(twilio.equip);
  expect(inhouse.conv).toEqual(twilio.conv);
  expect(inhouse.phones).toEqual(twilio.phones);
});

test('the only DB-visible difference is the recorded transcript_source', async () => {
  await request(app)
    .post('/api/transcription')
    .type('form')
    .send({ TranscriptionText: 'same words', Track: 'outbound_track', CallSid: 'CA1' })
    .expect(204);
  await flush();
  const twilioUpdate = pool.query.mock.calls.find((c) => /UPDATE nucleus_phone_calls/.test(c[0]) && /transcript_source/.test(c[0]));

  jest.clearAllMocks();
  installPool();

  await request(app)
    .post('/api/stt-ingest')
    .set('authorization', `Bearer ${SECRET}`)
    .send({ conferenceName: CONF, text: 'same words', speaker: 'agent' })
    .expect(204);
  await flush();
  const inhouseUpdate = pool.query.mock.calls.find((c) => /UPDATE nucleus_phone_calls/.test(c[0]) && /transcript_source/.test(c[0]));

  expect(twilioUpdate[1]).toEqual(['same words', 'twilio', 7]);
  expect(inhouseUpdate[1]).toEqual(['same words', 'inhouse', 7]);
});
