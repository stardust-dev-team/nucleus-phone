// stt-ingest route tests (nucleus-phone-rgja.7, Stage B4). Mocks the shared
// transcript-ingest module so these assert the ROUTE's contract — bearer auth, the
// dual-run drive/shadow gate, finalize forwarding, and the HTTP status contract the
// nucleus-stt HttpIngestClient depends on (401/503/404/204). The downstream pipeline
// behaviour is pinned separately in transcript-ingest.test.js + stt-equivalence.test.js.

jest.mock('../../lib/transcript-ingest', () => ({
  ingestTranscriptChunk: jest.fn().mockResolvedValue(),
  shadowLogChunk: jest.fn(),
  resolveCallByConference: jest.fn(),
  finalizeByConference: jest.fn().mockResolvedValue(),
}));
jest.mock('../../lib/inflight', () => ({ track: (p) => p }));
jest.mock('../../lib/health-tracker', () => ({ touch: jest.fn() }));

const request = require('supertest');
const express = require('express');
const ingest = require('../../lib/transcript-ingest');

const SECRET = 'test-stt-secret';
const CONF = 'nucleus-call-abc';
const CALL_ROW = { id: 7, conference_name: CONF, lead_phone: '+16025551212', use_inhouse_stt: true };

let app;
beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/stt-ingest', require('../stt-ingest'));
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STT_INGEST_SECRET = SECRET;
  ingest.ingestTranscriptChunk.mockResolvedValue();
  ingest.finalizeByConference.mockResolvedValue();
});

function post(body, token = SECRET) {
  const req = request(app).post('/api/stt-ingest').set('content-type', 'application/json');
  if (token !== null) req.set('authorization', `Bearer ${token}`);
  return req.send(body);
}

describe('bearer auth', () => {
  test('missing bearer → 401, no work', async () => {
    await post({ conferenceName: CONF, text: 'hi', speaker: 'agent' }, null).expect(401);
    expect(ingest.resolveCallByConference).not.toHaveBeenCalled();
  });

  test('wrong bearer → 401', async () => {
    await post({ conferenceName: CONF, text: 'hi', speaker: 'agent' }, 'nope').expect(401);
  });

  test('STT_INGEST_SECRET unset → 503 (fail closed, never open)', async () => {
    delete process.env.STT_INGEST_SECRET;
    await post({ conferenceName: CONF, text: 'hi', speaker: 'agent' }, 'anything').expect(503);
    expect(ingest.resolveCallByConference).not.toHaveBeenCalled();
  });
});

describe('dual-run gate', () => {
  test('use_inhouse_stt=true → drives via ingestTranscriptChunk(source:inhouse), no shadow', async () => {
    ingest.resolveCallByConference.mockResolvedValueOnce({ ...CALL_ROW, use_inhouse_stt: true });
    await post({ conferenceName: CONF, text: 'hello', speaker: 'customer' }).expect(204);

    expect(ingest.ingestTranscriptChunk).toHaveBeenCalledTimes(1);
    expect(ingest.ingestTranscriptChunk).toHaveBeenCalledWith({
      callRow: expect.objectContaining({ id: 7, conference_name: CONF }),
      text: 'hello',
      speaker: 'customer',
      source: 'inhouse',
    });
    expect(ingest.shadowLogChunk).not.toHaveBeenCalled();
  });

  test('use_inhouse_stt=false → shadow-logs only (Twilio drives), no ingest', async () => {
    ingest.resolveCallByConference.mockResolvedValueOnce({ ...CALL_ROW, use_inhouse_stt: false });
    await post({ conferenceName: CONF, text: 'hello', speaker: 'agent' }).expect(204);

    expect(ingest.shadowLogChunk).toHaveBeenCalledTimes(1);
    expect(ingest.shadowLogChunk).toHaveBeenCalledWith({
      source: 'inhouse',
      conferenceName: CONF,
      text: 'hello',
      speaker: 'agent',
    });
    expect(ingest.ingestTranscriptChunk).not.toHaveBeenCalled();
  });
});

describe('HTTP status contract (drives the client retry/dead-letter split)', () => {
  test('unknown conference → 404 (client dead-letters)', async () => {
    ingest.resolveCallByConference.mockResolvedValueOnce(null);
    await post({ conferenceName: CONF, text: 'hi', speaker: 'agent' }).expect(404);
  });

  test('DB lookup error → 503 (client retries)', async () => {
    ingest.resolveCallByConference.mockRejectedValueOnce(new Error('db down'));
    await post({ conferenceName: CONF, text: 'hi', speaker: 'agent' }).expect(503);
  });

  test('missing conferenceName → 400', async () => {
    await post({ text: 'hi', speaker: 'agent' }).expect(400);
  });

  test('chunk with no text → 204, no lookup', async () => {
    await post({ conferenceName: CONF, speaker: 'agent' }).expect(204);
    expect(ingest.resolveCallByConference).not.toHaveBeenCalled();
  });
});

describe('finalize (gated — only the driving source finalizes)', () => {
  // Finalize acks 204 then resolves+gates in the background (inflight track); let it settle.
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };

  test('in-house-driven call → finalizeByConference(conferenceName)', async () => {
    ingest.resolveCallByConference.mockResolvedValueOnce({ ...CALL_ROW, use_inhouse_stt: true });
    await post({ conferenceName: CONF, event: 'finalize' }).expect(204);
    await flush();
    expect(ingest.finalizeByConference).toHaveBeenCalledWith(CONF);
  });

  test('Twilio-driven call → does NOT finalize (Twilio transcription-stopped owns it)', async () => {
    // nucleus-stt POSTs finalize for EVERY streamed call; on a shadow (Twilio-driven) call
    // we must NOT also summarize, or the transcript gets summarized twice.
    ingest.resolveCallByConference.mockResolvedValueOnce({ ...CALL_ROW, use_inhouse_stt: false });
    await post({ conferenceName: CONF, event: 'finalize' }).expect(204);
    await flush();
    expect(ingest.finalizeByConference).not.toHaveBeenCalled();
  });

  test('unknown conference → no finalize, no throw', async () => {
    ingest.resolveCallByConference.mockResolvedValueOnce(null);
    await post({ conferenceName: CONF, event: 'finalize' }).expect(204);
    await flush();
    expect(ingest.finalizeByConference).not.toHaveBeenCalled();
  });
});
