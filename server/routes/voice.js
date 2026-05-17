const { Router } = require('express');
const { VoiceResponse } = require('../lib/twilio');
const { getConference } = require('../lib/conference');
const { pool } = require('../db');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook('/api/voice');

// POST /api/voice — TwiML webhook called by Twilio when PWA connects via Voice SDK
router.post('/', twilioWebhook, async (req, res) => {
  touch('twilio.webhook');
  logEvent('webhook', 'twilio.voice', `TwiML request: action=${req.body.Action || 'initiate'}, conf=${req.body.ConferenceName || 'none'}`);
  try {
    const { ConferenceName, Action, Muted } = req.body;
    const twiml = new VoiceResponse();

    if (Action === 'join') {
      const dial = twiml.dial();
      dial.conference({
        startConferenceOnEnter: false,
        endConferenceOnExit: false,
        muted: Muted === 'true',
        beep: false,
      }, ConferenceName);

      return res.type('text/xml').send(twiml.toString());
    }

    // Default: "initiate" — caller enters conference.
    // Lead dialing happens in the conference-start status callback (call.js),
    // NOT here. This eliminates the race condition of polling for the conference SID.

    // Save caller's CallSid for RT transcription webhook mapping.
    // The transcription webhook receives CallSid but the app tracks by
    // conference_name. This bridges the gap without in-memory cache
    // (which would be lost on Render restart).
    const updateResult = await pool.query(
      'UPDATE nucleus_phone_calls SET caller_call_sid = $1 WHERE conference_name = $2',
      [req.body.CallSid, ConferenceName]
    );
    if (updateResult.rowCount === 0) {
      console.warn(`voice: caller_call_sid UPDATE matched 0 rows for conference ${ConferenceName}`);
    }

    // Enable Twilio Real-Time Transcription (only in initiator's TwiML, not
    // join participants — one transcription stream per conference is sufficient).
    // If RT Transcription isn't enabled on the account, this verb is silently ignored.
    //
    // joruva-dialer-mac-djy: `partialResults: false`. Twilio's RT
    // Transcription with partial results enabled emits the running
    // transcription as it builds up — one utterance becomes 5+
    // webhooks ("A." → "A lot." → "A lot of." → …). The server
    // broadcasts every chunk to subscribers; iOS appends each to the
    // live transcript box, rendering the same utterance multiple
    // times with progressive expansion. End-state UX: transcript is
    // unreadable after 30s of conversation. With `partialResults:
    // false`, Twilio buffers until utterance is complete (~500ms-1s
    // latency tradeoff) and emits one webhook per finalized utterance
    // per speaker leg. Acceptable latency for the live cockpit's
    // read-by-rep use case.
    //
    // `track: 'both_tracks'` is preserved — that's per-speaker
    // diarization, not the dedup problem. The "both tracks doubling
    // when devices are co-located" subset of the original bd-djy
    // symptom is out of scope (separate bead if it ever materially
    // affects UX).
    const start = twiml.start();
    start.transcription({
      statusCallbackUrl: `${baseUrl}/api/transcription`,
      statusCallbackMethod: 'POST',
      track: 'both_tracks',
      languageCode: 'en-US',
      partialResults: false,
      intelligenceService: process.env.TWILIO_INTELLIGENCE_SERVICE_SID || undefined,
    });

    const dial = twiml.dial({ callerId: process.env.NUCLEUS_PHONE_NUMBER });
    dial.conference({
      record: 'record-from-start',
      recordingStatusCallback: `${baseUrl}/api/call/recording-status`,
      recordingStatusCallbackEvent: 'completed',
      statusCallback: `${baseUrl}/api/call/status`,
      statusCallbackEvent: 'start end join leave',
      startConferenceOnEnter: true,
      // Outbound iOS-leg only — this `voice.js` `Action='initiate'`
      // TwiML path is only reached for outbound calls (inbound iOS legs
      // are connected via `<Client>tom</Client>` from `incoming.js`'s
      // TwiML, which doesn't go through here). Hardcoding `true` is safe
      // for outbound: when the rep ends the call, the conference dies
      // and the lead leg drops, matching how the lead-leg flag works
      // (`call.js:327` uses `!isInbound`). If a future refactor pushes
      // inbound flows through this same TwiML, this becomes WRONG (the
      // rep hanging up mid-voicemail-leave would cut the caller off);
      // pin the assumption rather than mirror call.js blindly. Closes
      // joruva-dialer-mac-lkk's leak path where iOS End Call dropped its
      // leg but the lead leg + recording kept running until idle timeout.
      endConferenceOnExit: true,
      beep: false,
    }, ConferenceName);

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('voice: error generating TwiML:', err.message);
    // Return valid TwiML even on error — Twilio will hang up with an empty response
    const twiml = new VoiceResponse();
    twiml.say('An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

module.exports = router;
