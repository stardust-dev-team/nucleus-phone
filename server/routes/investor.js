/**
 * investor.js — Inbound calls to the Joruva investor relations line.
 *
 * Intentionally separate from incoming.js: investor calls bypass the conference
 * pipeline (no recording, no RT transcription, no Fireflies, no UCIL sync).
 * Pure forward to Tom's cell with a voicemail fallback if he doesn't answer.
 *
 * Twilio number routing: this handler is mounted at /api/voice/investor and
 * is wired to a dedicated investor DID (separate from the demo/sales line).
 *
 * Env vars:
 *   INVESTOR_FORWARD_NUMBER — E.164 cell number to ring (e.g. Tom's mobile)
 *   INVESTOR_CALLER_ID      — E.164 of the investor DID (shown on Tom's screen
 *                             so he can save it as "Joruva Investor Line")
 */

const { Router } = require('express');
const twilio = require('twilio');
const { VoiceResponse, client } = require('../lib/twilio');
const { sendSlackAlert } = require('../lib/slack');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const forwardTo = process.env.INVESTOR_FORWARD_NUMBER;
const investorDid = process.env.INVESTOR_CALLER_ID;
const smsAlertTo = process.env.INVESTOR_SMS_ALERT_TO;
const smsFrom = process.env.TWILIO_PHONE_NUMBER;

function makeTwilioWebhook(path) {
  return twilio.webhook({
    validate: process.env.NODE_ENV === 'production',
    url: `${baseUrl}${path}`,
  });
}

// ─── POST / — Investor inbound call handler ─────────────────────────

router.post('/', makeTwilioWebhook('/api/voice/investor'), (req, res) => {
  const callerPhone = req.body.From || 'unknown';
  const twiml = new VoiceResponse();

  if (!forwardTo) {
    console.error('investor: INVESTOR_FORWARD_NUMBER not set');
    twiml.say({ voice: 'Polly.Joanna-Generative' },
      'Thank you for calling Joruva. We are unable to take your call right now. Please email tom at Joruva dot com.');
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`investor: inbound from ${callerPhone} → forwarding to ${forwardTo}`);

  twiml.say({
    voice: 'Polly.Joanna-Generative',
  }, 'Connecting you with Tom Russo. Please hold.');

  // Forward to Tom's cell. callerId shows the investor DID on Tom's screen
  // (he saves it as "Joruva Investor Line" → instant recognition).
  // 30s timeout → voicemail fallback if no answer.
  const dial = twiml.dial({
    callerId: investorDid || callerPhone,
    timeout: 30,
    action: `${baseUrl}/api/voice/investor/dial-complete?from=${encodeURIComponent(callerPhone)}`,
  });
  dial.number(forwardTo);

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /dial-complete — Forward result (voicemail fallback) ──────

router.post('/dial-complete', makeTwilioWebhook('/api/voice/investor/dial-complete'), (req, res) => {
  const { DialCallStatus } = req.body;
  const callerPhone = req.query.from || 'unknown';
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`investor: dial fell through (${DialCallStatus}) for ${callerPhone}`);

  // Strategy C: record VM, then voicemail-complete fires Slack alert + SMS to Tom.
  twiml.say({
    voice: 'Polly.Joanna-Generative',
  }, 'Tom is not available right now. Please leave your name, your firm, and a callback number, and Tom will return your call within one business day. Press the pound key when finished.');
  twiml.record({
    maxLength: 180,
    playBeep: true,
    recordingStatusCallback: `${baseUrl}/api/voice/investor/voicemail-complete?from=${encodeURIComponent(callerPhone)}`,
    recordingStatusCallbackEvent: 'completed',
    recordingStatusCallbackMethod: 'POST',
  });
  twiml.say({ voice: 'Polly.Joanna-Generative' }, 'We did not receive a message. Goodbye.');

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /voicemail-complete — VM recording webhook ─────────────────

router.post('/voicemail-complete', makeTwilioWebhook('/api/voice/investor/voicemail-complete'), (req, res) => {
  res.sendStatus(204);

  const { RecordingUrl, RecordingDuration } = req.body;
  const callerPhone = req.query.from || 'unknown';
  if (!RecordingUrl) return;

  console.log(`investor: voicemail from ${callerPhone} (${RecordingDuration}s)`);

  // Strategy C: Slack alert + SMS to Tom's cell.
  sendSlackAlert({
    text: `:moneybag: *Investor voicemail* from ${callerPhone} (${RecordingDuration}s)\n${RecordingUrl}`,
  }).catch((err) => console.error('investor: slack alert failed:', err.message));

  if (smsAlertTo && smsFrom) {
    client.messages.create({
      to: smsAlertTo,
      from: smsFrom,
      body: `Investor VM from ${callerPhone} (${RecordingDuration}s): ${RecordingUrl}`,
    }).catch((err) => console.error('investor: SMS alert failed:', err.message));
  }
});

module.exports = router;
