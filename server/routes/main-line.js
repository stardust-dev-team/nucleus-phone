/**
 * main-line.js — IVR menu for the master Joruva inbound line.
 *
 * Sits in front of /api/voice/incoming. Callers hear a short menu:
 *   Press 1 → existing sales/demo flow (per-DID routing in incoming.js)
 *   Press 2 → investor relations (rings Tom's cell, no recording)
 *   No input → falls through to sales (Sean's demo experience: press 1 or wait)
 *
 * Per-rep direct DIDs (Ryann, Paul) bypass this route — their Twilio voice URL
 * still points to /api/voice/incoming directly. Only the master 800 line points
 * here.
 */

const { Router } = require('express');
const twilio = require('twilio');
const { VoiceResponse } = require('../lib/twilio');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';

function makeTwilioWebhook(path) {
  return twilio.webhook({
    validate: process.env.NODE_ENV === 'production',
    url: `${baseUrl}${path}`,
  });
}

// ─── POST / — IVR menu prompt ────────────────────────────────────────

router.post('/', makeTwilioWebhook('/api/voice/main'), (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    timeout: 4,
    action: `${baseUrl}/api/voice/main/menu`,
    method: 'POST',
  });

  gather.say({
    voice: 'Polly.Joanna',
  }, 'Thanks for calling Joruva Industrial. For sales, press 1 or stay on the line. For investor relations, press 2.');

  // No input → fall through to sales (Sean presses nothing → demo continues)
  twiml.redirect({ method: 'POST' }, `${baseUrl}/api/voice/incoming`);

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /menu — Handle digit press ─────────────────────────────────

router.post('/menu', makeTwilioWebhook('/api/voice/main/menu'), (req, res) => {
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  if (digit === '2') {
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/voice/investor`);
  } else {
    // "1" or anything else → sales flow
    twiml.redirect({ method: 'POST' }, `${baseUrl}/api/voice/incoming`);
  }

  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
