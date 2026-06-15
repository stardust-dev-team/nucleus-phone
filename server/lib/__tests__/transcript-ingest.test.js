// nucleus-phone-rgja.2 (Stage A) — pins the source-agnostic transcript
// pipeline. This is the safety proof for the in-house STT swap: as long as
// both the Twilio webhook and the (later) in-house ingest route call these
// same functions, every downstream consumer behaves identically.

jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('../live-analysis', () => ({ broadcast: jest.fn() }));
jest.mock('../equipment-pipeline', () => ({ processEquipmentChunk: jest.fn().mockResolvedValue() }));
jest.mock('../conversation-pipeline', () => ({ processConversationChunk: jest.fn().mockResolvedValue() }));
jest.mock('../phone-extractor', () => ({ capturePhones: jest.fn().mockResolvedValue() }));
jest.mock('../call-summarizer', () => ({ summarizeCall: jest.fn(), MIN_TRANSCRIPT_LENGTH: 50 }));

const { pool } = require('../../db');
const { broadcast } = require('../live-analysis');
const { processEquipmentChunk } = require('../equipment-pipeline');
const { processConversationChunk } = require('../conversation-pipeline');
const { capturePhones } = require('../phone-extractor');
const { summarizeCall } = require('../call-summarizer');

const {
  ingestTranscriptChunk,
  resolveCallByCallSid,
  resolveCallByConference,
  finalizeByCallSid,
  finalizeByConference,
} = require('../transcript-ingest');

const CALL_ROW = { id: 7, conference_name: 'nucleus-call-abc', lead_phone: '+16025551212' };

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  processEquipmentChunk.mockResolvedValue();
  processConversationChunk.mockResolvedValue();
  capturePhones.mockResolvedValue();
});

describe('ingestTranscriptChunk', () => {
  test('one chunk → exactly one of each downstream effect', async () => {
    await ingestTranscriptChunk({ callRow: CALL_ROW, text: 'hello there', speaker: 'agent' });

    // 1 accumulate UPDATE, nothing else on the DB
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('UPDATE nucleus_phone_calls');
    expect(sql).toContain('transcript_source = COALESCE(transcript_source, $2)');
    expect(params).toEqual(['hello there', 'twilio', 7]);

    // broadcast on the conference_name channel with the typed speaker
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('nucleus-call-abc', {
      type: 'transcript_chunk',
      data: { text: 'hello there', speaker: 'agent' },
    });

    // each pipeline fired exactly once, keyed on conference_name + String(id)
    expect(processEquipmentChunk).toHaveBeenCalledTimes(1);
    expect(processEquipmentChunk).toHaveBeenCalledWith('nucleus-call-abc', 'real', '7', 'hello there');
    expect(processConversationChunk).toHaveBeenCalledTimes(1);
    expect(processConversationChunk).toHaveBeenCalledWith('nucleus-call-abc', 'hello there');

    // capturePhones MUST receive lead_phone (review #6 — load-bearing)
    expect(capturePhones).toHaveBeenCalledTimes(1);
    expect(capturePhones).toHaveBeenCalledWith(7, '+16025551212', 'hello there');
  });

  test('transcript_source defaults to twilio and is overridable', async () => {
    await ingestTranscriptChunk({ callRow: CALL_ROW, text: 'x', speaker: 'customer', source: 'inhouse' });
    expect(pool.query.mock.calls[0][1]).toEqual(['x', 'inhouse', 7]);
  });

  test('equivalence: same chunk from twilio vs inhouse produces identical fan-out (only source differs)', async () => {
    await ingestTranscriptChunk({ callRow: CALL_ROW, text: 'same words', speaker: 'agent', source: 'twilio' });
    const twilio = {
      broadcast: broadcast.mock.calls[0],
      equip: processEquipmentChunk.mock.calls[0],
      conv: processConversationChunk.mock.calls[0],
      phones: capturePhones.mock.calls[0],
      updateParams: pool.query.mock.calls[0][1],
    };
    jest.clearAllMocks();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await ingestTranscriptChunk({ callRow: CALL_ROW, text: 'same words', speaker: 'agent', source: 'inhouse' });
    const inhouse = {
      broadcast: broadcast.mock.calls[0],
      equip: processEquipmentChunk.mock.calls[0],
      conv: processConversationChunk.mock.calls[0],
      phones: capturePhones.mock.calls[0],
      updateParams: pool.query.mock.calls[0][1],
    };

    // Every client-visible effect is identical...
    expect(inhouse.broadcast).toEqual(twilio.broadcast);
    expect(inhouse.equip).toEqual(twilio.equip);
    expect(inhouse.conv).toEqual(twilio.conv);
    expect(inhouse.phones).toEqual(twilio.phones);
    // ...the ONLY difference is the recorded source.
    expect(twilio.updateParams).toEqual(['same words', 'twilio', 7]);
    expect(inhouse.updateParams).toEqual(['same words', 'inhouse', 7]);
  });

  test('a DB accumulation failure does not block broadcast/pipelines', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await ingestTranscriptChunk({ callRow: CALL_ROW, text: 'resilient', speaker: 'agent' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(processEquipmentChunk).toHaveBeenCalledTimes(1);
  });
});

describe('resolvers return the pinned {id, conference_name, lead_phone} shape', () => {
  test('resolveCallByCallSid selects the pinned columns by caller_call_sid', async () => {
    pool.query.mockResolvedValueOnce({ rows: [CALL_ROW] });
    const row = await resolveCallByCallSid('CA123');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('id, conference_name, lead_phone');
    expect(sql).toContain('caller_call_sid = $1');
    expect(params).toEqual(['CA123']);
    expect(row).toBe(CALL_ROW);
  });

  test('resolveCallByConference selects by conference_name', async () => {
    pool.query.mockResolvedValueOnce({ rows: [CALL_ROW] });
    const row = await resolveCallByConference('nucleus-call-abc');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('id, conference_name, lead_phone');
    expect(sql).toContain('conference_name = $1');
    expect(params).toEqual(['nucleus-call-abc']);
    expect(row).toBe(CALL_ROW);
  });

  test('missing row → null (both resolvers)', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await resolveCallByCallSid('nope')).toBeNull();
    expect(await resolveCallByConference('nope')).toBeNull();
  });
});

describe('finalize — two explicit lookups, shared summarize tail', () => {
  const okSummary = {
    summary: 'they need a 30hp screw compressor', action_items: ['send quote'],
    products_discussed: ['JRS-30'], objections_raised: [], equipment_mentioned: ['Haas VF-2'],
    next_step: 'quote', disposition_suggestion: 'warm',
  };

  test('finalizeByCallSid looks up by caller_call_sid; short transcript → no summary, no write', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7, transcript: 'too short' }] });
    await finalizeByCallSid('CA1');
    expect(pool.query.mock.calls[0][0]).toContain('caller_call_sid = $1');
    expect(summarizeCall).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1); // SELECT only, no ai_* UPDATE
  });

  test('finalizeByCallSid long transcript → summarize + ai_* write', async () => {
    const transcript = 'a'.repeat(60);
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 7, transcript }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] });                     // UPDATE
    summarizeCall.mockResolvedValueOnce(okSummary);

    await finalizeByCallSid('CA1');

    expect(summarizeCall).toHaveBeenCalledWith(transcript);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toContain('ai_summary = $1');
    expect(updateSql).toContain('ai_summarized = TRUE');
    expect(updateParams[0]).toBe(okSummary.summary);
    expect(updateParams[2]).toBe('warm');
    expect(updateParams[3]).toBe(7);
  });

  test('finalizeByConference looks up by conference_name', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 9, transcript: 'a'.repeat(60) }] })
      .mockResolvedValueOnce({ rows: [] });
    summarizeCall.mockResolvedValueOnce(okSummary);

    await finalizeByConference('nucleus-call-xyz');

    expect(pool.query.mock.calls[0][0]).toContain('conference_name = $1');
    expect(pool.query.mock.calls[0][1]).toEqual(['nucleus-call-xyz']);
    expect(summarizeCall).toHaveBeenCalledTimes(1);
  });

  test('idempotency: both finalize SELECTs exclude already-summarized calls', async () => {
    // The AND ai_summarized IS NOT TRUE guard is what makes a duplicate finalize a no-op
    // (Twilio resend / dual-run double-fire) — no second paid summary, no overwrite.
    pool.query.mockResolvedValue({ rows: [] }); // already-summarized → guard excludes it
    await finalizeByCallSid('CA1');
    await finalizeByConference('nucleus-call-xyz');
    expect(pool.query.mock.calls[0][0]).toContain('ai_summarized IS NOT TRUE');
    expect(pool.query.mock.calls[1][0]).toContain('ai_summarized IS NOT TRUE');
    expect(summarizeCall).not.toHaveBeenCalled(); // no row → no summary
  });

  test('no call row → skip (no summarize, no write)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await finalizeByCallSid('CA-missing');
    expect(summarizeCall).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('summarizeCall error → no ai_* write', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7, transcript: 'a'.repeat(60) }] });
    summarizeCall.mockResolvedValueOnce({ error: true, message: 'claude timeout' });
    await finalizeByCallSid('CA1');
    expect(pool.query).toHaveBeenCalledTimes(1); // SELECT only
  });
});
