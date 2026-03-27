const { Router } = require('express');
const twilio = require('twilio');
const { pool } = require('../db');
const { uploadToFireflies } = require('../lib/fireflies');

const router = Router();
const twilioWebhook = twilio.webhook({ validate: false });

// POST /api/call/recording-status — Twilio recording status callback
router.post('/', twilioWebhook, async (req, res) => {
  const {
    RecordingUrl, RecordingSid, RecordingDuration, ConferenceSid,
  } = req.body;

  // Respond immediately — processing happens async
  res.sendStatus(204);

  if (!RecordingUrl || !ConferenceSid) return;

  try {
    // Find the call record by conference_sid
    const result = await pool.query(
      `SELECT id, conference_name, caller_identity, lead_name, lead_company, lead_phone
       FROM nucleus_phone_calls WHERE conference_sid = $1`,
      [ConferenceSid]
    );

    if (result.rows.length === 0) {
      console.warn(`No call record found for conference ${ConferenceSid}`);
      return;
    }

    const call = result.rows[0];

    // Save recording URL to database
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET recording_url = $1, recording_duration = $2
       WHERE id = $3`,
      [RecordingUrl, parseInt(RecordingDuration, 10) || null, call.id]
    );

    // Upload to Fireflies (non-blocking — failure here must not affect anything)
    const ffResult = await uploadToFireflies(RecordingUrl, {
      callerIdentity: call.caller_identity,
      leadName: call.lead_name,
      leadCompany: call.lead_company,
      leadPhone: call.lead_phone,
    });

    if (ffResult.success) {
      await pool.query(
        'UPDATE nucleus_phone_calls SET fireflies_uploaded = TRUE WHERE id = $1',
        [call.id]
      );
    }

    console.log(`Recording processed for call ${call.id}: Twilio ${RecordingSid}, Fireflies ${ffResult.success}`);
  } catch (err) {
    console.error('Recording processing failed:', err.message);
  }
});

module.exports = router;
