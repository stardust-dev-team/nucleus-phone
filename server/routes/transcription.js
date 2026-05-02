/**
 * transcription.js — Twilio Real-Time Transcription webhook.
 *
 * Receives partial/final transcript chunks from Twilio RT Transcription,
 * accumulates them in the database, runs the equipment detection pipeline,
 * and broadcasts results to WebSocket subscribers.
 *
 * CallSid mapping: uses caller_call_sid (saved in voice.js) to look up the
 * call row. This avoids the race condition where conference_sid isn't yet
 * written when the first transcription chunk arrives.
 *
 * Twilio also sends TranscriptionEvent callbacks (transcription-started,
 * transcription-stopped) to this URL without TranscriptionText — the early
 * return on missing TranscriptionText handles these gracefully.
 */

const { Router } = require('express');
const { pool } = require('../db');
const { broadcast } = require('../lib/live-analysis');
const { track } = require('../lib/inflight');
const { processEquipmentChunk } = require('../lib/equipment-pipeline');
const { processConversationChunk } = require('../lib/conversation-pipeline');
const { summarizeCall, MIN_TRANSCRIPT_LENGTH } = require('../lib/call-summarizer');
const { capturePhones } = require('../lib/phone-extractor');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook('/api/transcription');

router.post('/', twilioWebhook, async (req, res) => {
  touch('twilio.transcription');
  res.sendStatus(204);

  const { TranscriptionText, TranscriptionData, TranscriptionEvent, Track, CallSid } = req.body;

  // Voice Intelligence sends transcript in TranscriptionData (JSON string),
  // older RT Transcription uses TranscriptionText (plain text).
  let transcriptText = TranscriptionText || null;
  if (!transcriptText && TranscriptionData) {
    try {
      const parsed = JSON.parse(TranscriptionData);
      transcriptText = parsed.transcript || parsed.text || TranscriptionData;
    } catch {
      transcriptText = TranscriptionData; // plain text fallback
    }
  }

  // Twilio sends transcription-stopped when all chunks are delivered —
  // trigger post-call summarization here instead of racing in recording.js.
  logEvent('webhook', 'twilio.transcription', `event=${TranscriptionEvent || 'chunk'}, track=${Track || 'n/a'}, hasText=${!!transcriptText}`);

  if (TranscriptionEvent === 'transcription-stopped' && CallSid) {
    track(
      runPostCallSummary(CallSid).catch(err => {
        console.error('transcription: post-call summary failed:', err.message);
      })
    );
    return;
  }

  if (!transcriptText || !CallSid) return;

  // Look up call by caller_call_sid
  let call;
  try {
    const { rows } = await pool.query(
      'SELECT id, conference_name, lead_phone FROM nucleus_phone_calls WHERE caller_call_sid = $1',
      [CallSid]
    );
    call = rows[0];
  } catch (err) {
    console.error('transcription: call lookup failed:', err.message);
    return;
  }

  if (!call) {
    console.warn(`transcription: no call found for CallSid ${CallSid}`);
    return;
  }

  const callId = call.conference_name;

  // Accumulate transcript in DB
  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET transcript = COALESCE(transcript, '') || $1 || E'\\n'
       WHERE id = $2`,
      [transcriptText, call.id]
    );
  } catch (err) {
    console.error('transcription: transcript accumulation failed:', err.message);
  }

  // Broadcast raw transcript chunk
  broadcast(callId, {
    type: 'transcript_chunk',
    data: { text: transcriptText, speaker: Track || 'unknown' },
  });

  // Run entity extraction pipeline (fire-and-forget, don't block)
  processEquipmentChunk(callId, 'real', String(call.id), transcriptText).catch((err) => {
    console.error('transcription: pipeline error:', err.message);
  });

  // Run conversation analysis pipeline (fire-and-forget, parallel to equipment)
  processConversationChunk(callId, transcriptText).catch((err) => {
    console.error('transcription: conversation pipeline error:', err.message);
  });

  // Capture any phone numbers spoken during the call
  capturePhones(call.id, call.lead_phone, transcriptText).catch((err) => {
    console.error('transcription: phone capture error:', err.message);
  });
});

/**
 * Run Claude summarization after Twilio signals transcription is complete.
 * No more sleep-and-retry — transcription-stopped guarantees all chunks landed.
 */
async function runPostCallSummary(callSid) {
  const { rows } = await pool.query(
    'SELECT id, transcript FROM nucleus_phone_calls WHERE caller_call_sid = $1',
    [callSid]
  );
  const call = rows[0];
  if (!call) {
    console.warn(`transcription: summary skipped — no call for CallSid ${callSid}`);
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

module.exports = router;
