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
const twilio = require('twilio');
const { pool } = require('../db');
const { broadcast } = require('../lib/live-analysis');
const { processEquipmentChunk } = require('../lib/equipment-pipeline');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/transcription`,
});

router.post('/', twilioWebhook, async (req, res) => {
  // Respond immediately — Twilio doesn't wait for processing
  res.sendStatus(204);

  const { TranscriptionText, Track, CallSid } = req.body;

  // Twilio sends status events (transcription-started/stopped) without text
  if (!TranscriptionText || !CallSid) return;

  // Look up call by caller_call_sid
  let call;
  try {
    const { rows } = await pool.query(
      'SELECT id, conference_name FROM nucleus_phone_calls WHERE caller_call_sid = $1',
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
      [TranscriptionText, call.id]
    );
  } catch (err) {
    console.error('transcription: transcript accumulation failed:', err.message);
  }

  // Broadcast raw transcript chunk
  broadcast(callId, {
    type: 'transcript_chunk',
    data: { text: TranscriptionText, speaker: Track || 'unknown' },
  });

  // Run entity extraction pipeline (fire-and-forget, don't block)
  processEquipmentChunk(callId, 'real', String(call.id), TranscriptionText).catch((err) => {
    console.error('transcription: pipeline error:', err.message);
  });
});

module.exports = router;
