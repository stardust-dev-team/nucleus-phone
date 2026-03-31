const { Router } = require('express');
const twilio = require('twilio');
const { pool } = require('../db');

const router = Router();
const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/call/recording-status`,
});

// POST /api/call/recording-status — Twilio recording status callback
// Only saves the recording URL. Summarization is triggered by the
// transcription-stopped event in transcription.js — no more race condition.
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
  } catch (err) {
    console.error('Recording processing failed:', err.message);
  }
});

module.exports = router;
