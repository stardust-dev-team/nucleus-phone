const { Router } = require('express');
const twilio = require('twilio');
const { VoiceResponse } = require('../lib/twilio');
const { getConference } = require('../lib/conference');

const router = Router();

const twilioWebhook = twilio.webhook({ validate: false });

// POST /api/voice — TwiML webhook called by Twilio when PWA connects via Voice SDK
router.post('/', twilioWebhook, (req, res) => {
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
  const dial = twiml.dial({ callerId: process.env.NUCLEUS_PHONE_NUMBER });
  dial.conference({
    record: 'record-from-start',
    recordingStatusCallback: '/api/call/recording-status',
    recordingStatusCallbackEvent: 'completed',
    statusCallback: '/api/call/status',
    statusCallbackEvent: 'start end join leave',
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    beep: false,
  }, ConferenceName);

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
