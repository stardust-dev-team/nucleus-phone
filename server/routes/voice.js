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
    const start = twiml.start();
    start.transcription({
      statusCallbackUrl: `${baseUrl}/api/transcription`,
      statusCallbackMethod: 'POST',
      track: 'both_tracks',
      languageCode: 'en-US',
      partialResults: true,
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
      endConferenceOnExit: false,
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
