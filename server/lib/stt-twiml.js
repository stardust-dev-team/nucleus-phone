/**
 * stt-twiml.js — shared <Start> verb emission for the in-house STT swap
 * (nucleus-phone-rgja.7, Stage B4). Both the outbound (voice.js) and inbound-PSTN
 * (incoming.js) conference TwiML paths attach the SAME two verbs, so they live here
 * rather than in two drifting copies:
 *
 *   - <Transcription> (Twilio RT) — emitted UNLESS STT_FALLBACK_TWILIO === 'false'.
 *     Default (unset) keeps it ON for dual-run; set 'false' post-flip to drop Twilio RT
 *     (in-house drives); set 'true' during a nucleus-stt outage to re-add it. It is a
 *     PREEMPTIVE switch — it changes the TwiML of calls that START after it's set, never
 *     a call already in progress (TwiML is fixed per call; plan review #5).
 *
 *   - <Stream both_tracks> + <Parameter name="conference_name"> — emitted ONLY when
 *     STT_WS_URL is set (i.e. the nucleus-stt service is deployed). So this whole module
 *     is INERT in production until that env lands: no <Stream>, and <Transcription>
 *     behaves exactly as before. conference_name rides as a <Parameter> so nucleus-stt
 *     keys ingest on it with no DB lookup (callId == conference_name; plan review #9).
 *
 * Exactly one SOURCE drives a call (the use_inhouse_stt gate at the ingest layer); both
 * verbs may be live at once during validation — the non-driving one only shadow-logs.
 *
 * The Twilio <Transcription> options are pinned to the values both routes already used:
 * track 'both_tracks' (per-speaker diarization) + partialResults:false (one finalized
 * chunk per utterance — matches the in-house finalized-per-FINISH cadence the
 * conversation pipeline's MIN_BUFFER_CHUNKS expects; joruva-dialer-mac-djy / rgja.2 #8).
 */

function wantTwilioTranscription() {
  return (process.env.STT_FALLBACK_TWILIO || '').toLowerCase() !== 'false';
}

/**
 * Attach the STT <Start> verbs to a VoiceResponse. No-op-emits nothing if neither verb
 * is wanted (so we never render an empty <Start/>).
 *
 * @param {import('twilio').twiml.VoiceResponse} twiml
 * @param {{ conferenceName: string, baseUrl: string }} opts
 */
function attachSttVerbs(twiml, { conferenceName, baseUrl }) {
  const emitTranscription = wantTwilioTranscription();
  const sttWsUrl = process.env.STT_WS_URL;
  if (!emitTranscription && !sttWsUrl) return;

  const start = twiml.start();

  if (emitTranscription) {
    const txOpts = {
      statusCallbackUrl: `${baseUrl}/api/transcription`,
      statusCallbackMethod: 'POST',
      track: 'both_tracks',
      languageCode: 'en-US',
      partialResults: false,
    };
    if (process.env.TWILIO_INTELLIGENCE_SERVICE_SID) {
      txOpts.intelligenceService = process.env.TWILIO_INTELLIGENCE_SERVICE_SID;
    }
    start.transcription(txOpts);
  }

  if (sttWsUrl) {
    const stream = start.stream({ url: sttWsUrl, track: 'both_tracks' });
    stream.parameter({ name: 'conference_name', value: conferenceName });
  }
}

module.exports = { attachSttVerbs };
