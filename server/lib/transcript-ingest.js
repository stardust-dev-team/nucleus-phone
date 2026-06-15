/**
 * transcript-ingest.js — source-agnostic transcript chunk handling.
 *
 * Both the Twilio Real-Time Transcription webhook (routes/transcription.js)
 * and the in-house Media-Streams STT path (routes/stt-ingest.js, added in a
 * later stage of nucleus-phone-rgja) funnel finalized chunks through this one
 * module, so the /api/live-analysis WS contract, the equipment/conversation/
 * phone pipelines, the DB transcript accumulation, and the post-call summary
 * stay byte-for-byte identical regardless of where the text came from.
 *
 * Invariants:
 *  - `callRow` is pinned to { id, conference_name, lead_phone } — `lead_phone`
 *    is load-bearing for capturePhones, so BOTH resolvers MUST select it.
 *  - `callId === conference_name` everywhere (the /api/live-analysis WS key).
 *  - The two finalize paths are TWO explicit queries (NOT an OR): the Twilio
 *    webhook looks up by `caller_call_sid`, the in-house path by
 *    `conference_name`. (caller_call_sid is the LEAD's SID on inbound and the
 *    REP's on outbound — an existing asymmetry the unchanged Twilio query
 *    already handles; the in-house path sidesteps it via conference_name.)
 *
 * Bead: nucleus-phone-rgja.2 (Stage A). Plan:
 * /Users/outpost/.claude/plans/stateful-bubbling-llama.md
 */

const { pool } = require('../db');
const { broadcast } = require('./live-analysis');
const { processEquipmentChunk } = require('./equipment-pipeline');
const { processConversationChunk } = require('./conversation-pipeline');
const { summarizeCall, MIN_TRANSCRIPT_LENGTH } = require('./call-summarizer');
const { capturePhones } = require('./phone-extractor');

// The pinned callRow shape every resolver returns and ingestTranscriptChunk
// expects. `lead_phone` MUST stay selected — capturePhones no-ops without it.
// `use_inhouse_stt` is the per-call gate (nucleus-phone-rgja.7): both ingest entry
// points read it to decide drive-vs-shadow, so BOTH resolvers must select it.
const CALL_ROW_COLUMNS = 'id, conference_name, lead_phone, use_inhouse_stt';

async function resolveCallByCallSid(callSid) {
  const { rows } = await pool.query(
    `SELECT ${CALL_ROW_COLUMNS} FROM nucleus_phone_calls WHERE caller_call_sid = $1`,
    [callSid]
  );
  return rows[0] || null;
}

async function resolveCallByConference(conferenceName) {
  const { rows } = await pool.query(
    `SELECT ${CALL_ROW_COLUMNS} FROM nucleus_phone_calls WHERE conference_name = $1`,
    [conferenceName]
  );
  return rows[0] || null;
}

/**
 * Accumulate one finalized transcript chunk and fan it out to every
 * downstream consumer — identical to the pre-refactor Twilio webhook body
 * (transcription.js:99-136).
 *
 * @param {Object}  args
 * @param {{id:number,conference_name:string,lead_phone:?string}} args.callRow
 * @param {string}  args.text     finalized utterance text
 * @param {'agent'|'customer'|'unknown'} args.speaker  already-typed speaker
 * @param {'twilio'|'inhouse'}    [args.source='twilio']  which STT produced it
 */
async function ingestTranscriptChunk({ callRow, text, speaker, source = 'twilio' }) {
  const callId = callRow.conference_name;

  // Accumulate transcript + stamp the producing source ONCE. COALESCE keeps
  // the first writer's source, so a shadow-logging source during dual-run
  // can't overwrite the driving source's stamp (review #7).
  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET transcript = COALESCE(transcript, '') || $1 || E'\\n',
           transcript_source = COALESCE(transcript_source, $2)
       WHERE id = $3`,
      [text, source, callRow.id]
    );
  } catch (err) {
    console.error('transcript-ingest: accumulation failed:', err.message);
  }

  // Broadcast to /api/live-analysis subscribers (iOS LiveAnalysisClient + PWA
  // cockpit). `speaker` is already typed agent/customer/unknown.
  broadcast(callId, {
    type: 'transcript_chunk',
    data: { text, speaker },
  });

  // Fire-and-forget analysis pipelines — never block the webhook/ingest ack.
  processEquipmentChunk(callId, 'real', String(callRow.id), text).catch((err) => {
    console.error('transcript-ingest: equipment pipeline error:', err.message);
  });
  processConversationChunk(callId, text).catch((err) => {
    console.error('transcript-ingest: conversation pipeline error:', err.message);
  });
  capturePhones(callRow.id, callRow.lead_phone, text).catch((err) => {
    console.error('transcript-ingest: phone capture error:', err.message);
  });
}

/**
 * Shadow-log a chunk from the NON-driving source during dual-run. Records only
 * what WER/latency comparison needs (conference, speaker, text length) — never
 * writes the transcript, never broadcasts, never runs a pipeline. Exactly one
 * source feeds a call (the use_inhouse_stt gate); the other lands here so we can
 * compare in-house vs Twilio before the flip (plan §rollout).
 *
 * @param {Object} args
 * @param {'twilio'|'inhouse'} args.source  the shadow (non-driving) source
 * @param {string} args.conferenceName
 * @param {string} args.text
 * @param {string} args.speaker
 */
function shadowLogChunk({ source, conferenceName, text, speaker }) {
  console.log(
    `shadow-stt[${source}]: conference=${conferenceName} speaker=${speaker} len=${(text || '').length}`
  );
}

// --- Post-call summary --------------------------------------------------
// Two explicit entry points sharing one summarize-and-write tail. Splitting
// (rather than an OR query) keeps each lookup obvious and avoids the
// caller_call_sid inbound/outbound asymmetry leaking into the in-house path.

// `AND ai_summarized IS NOT TRUE` makes finalize IDEMPOTENT: a second finalize for the
// same call (Twilio resending transcription-stopped, or a dual-run double-fire) finds no
// row and skips — no second paid Claude summarization, no overwrite (nucleus-phone-rgja.7
// Linus review). IS NOT TRUE (not `= FALSE`) so a NULL ai_summarized still summarizes once.

function finalizeByCallSid(callSid) {
  return summarizeByKey(
    'SELECT id, transcript FROM nucleus_phone_calls WHERE caller_call_sid = $1 AND ai_summarized IS NOT TRUE',
    callSid,
    `CallSid ${callSid}`
  );
}

function finalizeByConference(conferenceName) {
  return summarizeByKey(
    'SELECT id, transcript FROM nucleus_phone_calls WHERE conference_name = $1 AND ai_summarized IS NOT TRUE',
    conferenceName,
    `conference ${conferenceName}`
  );
}

async function summarizeByKey(selectSql, keyValue, label) {
  const { rows } = await pool.query(selectSql, [keyValue]);
  const call = rows[0];
  if (!call) {
    console.warn(`transcript-ingest: summary skipped — no call for ${label}`);
    return;
  }

  if (!call.transcript || call.transcript.length < MIN_TRANSCRIPT_LENGTH) {
    console.warn(`Call ${call.id}: transcript too short (${(call.transcript || '').length} chars) — skipping summarization`);
    return;
  }

  const summary = await summarizeCall(call.transcript);
  if (summary.error) {
    console.warn(`Call ${call.id}: AI summary failed: ${summary.message}`);
    return;
  }

  const actionItemsBlob = {
    action_items: summary.action_items,
    products_discussed: summary.products_discussed,
    objections_raised: summary.objections_raised,
    equipment_mentioned: summary.equipment_mentioned,
    next_step: summary.next_step,
  };

  await pool.query(
    `UPDATE nucleus_phone_calls SET
      ai_summary = $1, ai_action_items = $2,
      ai_disposition_suggestion = $3, ai_summarized = TRUE
     WHERE id = $4`,
    [summary.summary, JSON.stringify(actionItemsBlob),
     summary.disposition_suggestion, call.id]
  );

  console.log(`Call ${call.id}: AI summary complete (disposition: ${summary.disposition_suggestion})`);
}

module.exports = {
  ingestTranscriptChunk,
  shadowLogChunk,
  resolveCallByCallSid,
  resolveCallByConference,
  finalizeByCallSid,
  finalizeByConference,
};
