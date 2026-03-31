const { Router } = require('express');
const twilio = require('twilio');
const { pool } = require('../db');
const { summarizeCall, MIN_TRANSCRIPT_LENGTH } = require('../lib/call-summarizer');

const router = Router();
const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/call/recording-status`,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    // Summarize via Claude if transcript exists.
    // TODO: The sleep-and-retry is a pragmatic short-term fix for the race where
    // the recording webhook fires before all RT transcript chunks land. At current
    // call volume (6-person team) this is fine. If volume grows, decouple
    // summarization into a separate trigger (e.g. fire from transcription-stopped
    // event or a polling job).
    let transcript = await getTranscript(call.id);
    if (!transcript || transcript.length < MIN_TRANSCRIPT_LENGTH) {
      console.log(`Call ${call.id}: transcript not ready, retrying in 5s...`);
      await sleep(5000);
      transcript = await getTranscript(call.id);
    }

    let summarized = false;
    if (transcript && transcript.length >= MIN_TRANSCRIPT_LENGTH) {
      const summary = await summarizeCall(transcript);
      if (!summary.error) {
        // Persist the full summary output — ai_action_items stores a rich JSON
        // blob with action_items, products_discussed, objections_raised,
        // equipment_mentioned, and next_step for dashboard use.
        const actionItemsBlob = {
          action_items: summary.action_items,
          products_discussed: summary.products_discussed,
          objections_raised: summary.objections_raised,
          equipment_mentioned: summary.equipment_mentioned,
          next_step: summary.next_step,
        };
        await pool.query(
          `UPDATE nucleus_phone_calls SET
            ai_summary = $1, ai_action_items = $2,
            ai_disposition_suggestion = $3, ai_summarized = TRUE
           WHERE id = $4`,
          [summary.summary, JSON.stringify(actionItemsBlob),
           summary.disposition_suggestion, call.id]
        );
        summarized = true;
        console.log(`Call ${call.id}: AI summary complete (disposition: ${summary.disposition_suggestion})`);
      } else {
        console.warn(`Call ${call.id}: AI summary failed: ${summary.message}`);
      }
    } else {
      console.warn(`Call ${call.id}: transcript unavailable after retry — skipping summarization`);
    }

    console.log(`Recording saved for call ${call.id}: ${RecordingSid} (summarized: ${summarized})`);
  } catch (err) {
    console.error('Recording processing failed:', err.message);
  }
});

async function getTranscript(callId) {
  const { rows } = await pool.query(
    'SELECT transcript FROM nucleus_phone_calls WHERE id = $1',
    [callId]
  );
  return rows[0]?.transcript || null;
}

module.exports = router;
