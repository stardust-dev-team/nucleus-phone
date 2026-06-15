/**
 * transcription.js — Twilio Real-Time Transcription webhook.
 *
 * Receives partial/final transcript chunks from Twilio RT Transcription and
 * routes them into the shared, source-agnostic pipeline in
 * lib/transcript-ingest.js (which both this Twilio path and the in-house
 * Media-Streams STT path share, so downstream behaviour is identical). This
 * file is now just the Twilio-specific adapter: parse the webhook body, map
 * Twilio's `Track` to a typed speaker, look the call up by `caller_call_sid`,
 * and delegate.
 *
 * CallSid mapping: uses caller_call_sid (saved in voice.js) to look up the
 * call row — avoids the race where conference_sid isn't yet written when the
 * first transcription chunk arrives.
 *
 * Twilio also sends TranscriptionEvent callbacks (transcription-started,
 * transcription-stopped) without TranscriptionText — the early return on
 * missing TranscriptionText handles these; transcription-stopped triggers the
 * post-call summary.
 */

const { Router } = require('express');
const { track } = require('../lib/inflight');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');
const {
  ingestTranscriptChunk,
  resolveCallByCallSid,
  finalizeByCallSid,
} = require('../lib/transcript-ingest');

const router = Router();

const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook();

// Map Twilio RT Transcription's `Track` webhook field to the typed `speaker`
// value clients expect. Twilio sends `inbound_track` / `outbound_track` /
// `both_tracks`; iOS + PWA expect `agent` / `customer` / `unknown`. Outbound =
// the rep's mic feed (us), inbound = the lead's. joruva-dialer-mac-xft:
// pre-fix, raw Twilio values were forwarded and iOS DecodingError tore the
// live-analysis WebSocket down on first chunk.
function mapSpeaker(track) {
  if (track === 'outbound_track') return 'agent';
  if (track === 'inbound_track') return 'customer';
  return 'unknown';
}

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

  logEvent('webhook', 'twilio.transcription', `event=${TranscriptionEvent || 'chunk'}, track=${Track || 'n/a'}, hasText=${!!transcriptText}`);

  // Twilio sends transcription-stopped when all chunks are delivered —
  // trigger post-call summarization here instead of racing in recording.js.
  if (TranscriptionEvent === 'transcription-stopped' && CallSid) {
    track(
      finalizeByCallSid(CallSid).catch(err => {
        console.error('transcription: post-call summary failed:', err.message);
      })
    );
    return;
  }

  if (!transcriptText || !CallSid) return;

  let call;
  try {
    call = await resolveCallByCallSid(CallSid);
  } catch (err) {
    console.error('transcription: call lookup failed:', err.message);
    return;
  }

  if (!call) {
    console.warn(`transcription: no call found for CallSid ${CallSid}`);
    return;
  }

  await ingestTranscriptChunk({
    callRow: call,
    text: transcriptText,
    speaker: mapSpeaker(Track),
    source: 'twilio',
  });
});

module.exports = router;
module.exports.mapSpeaker = mapSpeaker;
