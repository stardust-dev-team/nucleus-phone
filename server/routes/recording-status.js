const { Router } = require('express');
const { pool } = require('../db');
const { uploadToFireflies } = require('../lib/fireflies');
const { track } = require('../lib/inflight');

const router = Router();
const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook('/api/call/recording-status');

// POST /api/call/recording-status — Twilio recording status callback.
// Saves the recording URL; summarization is triggered by the
// transcription-stopped event in transcription.js. Auth is the Twilio
// signature (twilioWebhook). Distinct from /api/recording (signed-URL +
// stream proxy for client playback) — split in nucleus-phone-op7.
router.post('/', twilioWebhook, async (req, res) => {
  const {
    RecordingUrl, RecordingSid, RecordingDuration, ConferenceSid,
  } = req.body;

  res.sendStatus(204);

  if (!RecordingUrl || !ConferenceSid) return;

  try {
    const result = await pool.query(
      `SELECT id FROM nucleus_phone_calls WHERE conference_sid = $1`,
      [ConferenceSid]
    );

    if (result.rows.length === 0) {
      console.warn(`No call record found for conference ${ConferenceSid}`);
      return;
    }

    const call = result.rows[0];

    await pool.query(
      `UPDATE nucleus_phone_calls
       SET recording_url = $1, recording_duration = $2
       WHERE id = $3`,
      [RecordingUrl, parseInt(RecordingDuration, 10) || null, call.id]
    );

    console.log(`Recording saved for call ${call.id}: ${RecordingSid}`);

    // Upload to Fireflies for transcription (async, non-blocking)
    const { rows: callRows } = await pool.query(
      `SELECT caller_identity, lead_name, lead_company, lead_phone, lead_email
       FROM nucleus_phone_calls WHERE id = $1`,
      [call.id]
    );
    if (callRows[0]) {
      const c = callRows[0];
      track(
        uploadToFireflies(RecordingUrl, {
          callerIdentity: c.caller_identity,
          leadName: c.lead_name,
          leadCompany: c.lead_company,
          leadPhone: c.lead_phone,
          leadEmail: c.lead_email,
        }).then(result => {
          if (result.success) {
            return pool.query('UPDATE nucleus_phone_calls SET fireflies_uploaded = TRUE WHERE id = $1', [call.id]);
          }
        }).catch(err => console.error('Fireflies upload failed:', err.message))
      );
    }
  } catch (err) {
    console.error('Recording processing failed:', err.message);
  }
});

module.exports = router;
