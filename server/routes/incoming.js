/**
 * incoming.js — Handles inbound calls to the Nucleus Phone number.
 *
 * Routes inbound calls through the same conference architecture as outbound
 * calls so they get recording, RT transcription, Fireflies upload, equipment
 * detection, AI summary, and UCIL sync — the full Nucleus flywheel.
 *
 * Flow:
 *   1. Caller dials (602) 600-0188
 *   2. Twilio hits POST /api/voice/incoming
 *   3. We create a DB row + in-memory conference state
 *   4. TwiML: "Please hold" → caller joins conference with recording + RT transcription
 *   5. Status callback (existing /api/call/status) dials the rep into the conference
 *   6. If rep answers: endConferenceOnExit enabled, full pipeline runs
 *   7. If rep doesn't answer (25s): rep-status redirects caller to voicemail
 *   8. If rep-status redirect fails: <Dial timeout=35> expires, dial-complete
 *      action URL catches the caller and serves voicemail (safety net)
 *
 * Config: INBOUND_FORWARD_NUMBER env var (E.164 format).
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { VoiceResponse, client } = require('../lib/twilio');
const { pool } = require('../db');
const { createConference } = require('../lib/conference');
const { sendSlackAlert, sendSlackDM } = require('../lib/slack');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';

function makeTwilioWebhook(path) {
  return twilio.webhook({
    validate: process.env.NODE_ENV === 'production',
    url: `${baseUrl}${path}`,
  });
}

/**
 * Append voicemail TwiML (say + record + goodbye) to a VoiceResponse.
 * Used by three paths: inline safety net, dial-complete fallback, and
 * rep-status redirect. Kept in one place to avoid drift.
 */
function appendVoicemailTwiml(twiml, callerPhone) {
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. No one is available to take your call right now. Please leave a message after the tone and we will get back to you as soon as possible.');
  twiml.record({
    maxLength: 180,
    playBeep: true,
    recordingStatusCallback: `${baseUrl}/api/voice/incoming/voicemail-complete?from=${encodeURIComponent(callerPhone)}`,
    recordingStatusCallbackEvent: 'completed',
    recordingStatusCallbackMethod: 'POST',
  });
  twiml.say('We did not receive a message. Goodbye.');
}

// ─── POST / — Initial inbound call handler ──────────────────────────

router.post('/', makeTwilioWebhook('/api/voice/incoming'), async (req, res) => {
  const forwardTo = process.env.INBOUND_FORWARD_NUMBER;
  const twiml = new VoiceResponse();

  if (!forwardTo) {
    console.error('incoming: INBOUND_FORWARD_NUMBER not set');
    twiml.say('Thank you for calling Joruva. We are currently unavailable. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const callerPhone = req.body.From || 'unknown';
  const callerCallSid = req.body.CallSid;

  if (!callerCallSid) {
    console.error('incoming: no CallSid in webhook body');
    twiml.say('Thank you for calling Joruva. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const conferenceName = `nucleus-inbound-${uuidv4()}`;

  console.log(`incoming: ${callerPhone} calling in — conference ${conferenceName}`);

  // Create DB row — same schema as outbound, but direction='inbound' and
  // lead_phone stores the CALLER's number (for identity resolution).
  let dbRowId;
  try {
    const result = await pool.query(
      `INSERT INTO nucleus_phone_calls
        (conference_name, caller_identity, caller_call_sid, lead_phone, direction)
       VALUES ($1, $2, $3, $4, 'inbound')
       RETURNING id`,
      [conferenceName, 'inbound', callerCallSid, callerPhone]
    );
    dbRowId = result.rows[0].id;
  } catch (err) {
    console.error('incoming: DB insert failed:', err.message);
    twiml.say('Thank you for calling Joruva. We are experiencing technical difficulties. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  // Create in-memory conference state.
  // leadPhone = the rep's number (who gets dialed INTO the conference).
  // The status callback at /api/call/status reads conf.leadPhone to know
  // who to dial on conference-start.
  createConference(conferenceName, {
    callerIdentity: 'inbound',
    to: forwardTo,
    contactName: callerPhone,
    companyName: null,
    contactId: null,
    dbRowId,
  });

  // Hold message so the caller doesn't hear silence while rep's phone rings
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. Please hold while we connect you.');

  // Enable RT transcription (same as outbound voice.js)
  const start = twiml.start();
  const txOpts = {
    statusCallbackUrl: `${baseUrl}/api/transcription`,
    statusCallbackMethod: 'POST',
    track: 'both_tracks',
    languageCode: 'en-US',
    partialResults: true,
  };
  if (process.env.TWILIO_INTELLIGENCE_SERVICE_SID) {
    txOpts.intelligenceService = process.env.TWILIO_INTELLIGENCE_SERVICE_SID;
  }
  start.transcription(txOpts);

  // Put the inbound caller into a conference with recording.
  // startConferenceOnEnter=true → conference starts immediately.
  // Status callback fires conference-start → dials the rep (25s timeout).
  //
  // The <Dial timeout=35> is a SAFETY NET, not the primary voicemail trigger.
  // Primary path: rep's 25s timeout fires → rep-status callback redirects
  // caller to voicemail via Twilio REST API. If that redirect fails, the
  // caller sits in an empty conference for ~10 more seconds until this 35s
  // <Dial> expires, then dial-complete action URL serves voicemail TwiML.
  const dial = twiml.dial({
    callerId: callerPhone,
    timeout: 35,
    action: `${baseUrl}/api/voice/incoming/dial-complete?conf=${encodeURIComponent(conferenceName)}&from=${encodeURIComponent(callerPhone)}`,
  });
  dial.conference({
    record: 'record-from-start',
    recordingStatusCallback: `${baseUrl}/api/call/recording-status`,
    recordingStatusCallbackEvent: 'completed',
    statusCallback: `${baseUrl}/api/call/status`,
    statusCallbackEvent: 'start end join leave',
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    beep: false,
    waitUrl: '', // Twilio default hold music while waiting for rep
  }, conferenceName);

  // Inline voicemail TwiML after <Dial> — tertiary safety net if both
  // the rep-status redirect AND dial-complete action URL somehow fail.
  appendVoicemailTwiml(twiml, callerPhone);

  // Slack: alert admin channel + DM the rep with cockpit deep link
  const cockpitUrl = `${baseUrl}/cockpit/${encodeURIComponent(callerPhone)}?conf=${encodeURIComponent(conferenceName)}`;
  sendSlackAlert({
    text: `:telephone_receiver: Inbound call from ${callerPhone} — dialing rep`,
  }).catch(() => {});

  const repSlackChannel = process.env.INBOUND_REP_SLACK_DM;
  if (repSlackChannel) {
    sendSlackDM(repSlackChannel,
      `:telephone_receiver: Inbound call from ${callerPhone}\n<${cockpitUrl}|Open Cockpit>`
    ).catch(() => {});
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /dial-complete — <Dial> action URL (safety net) ───────────

router.post('/dial-complete', makeTwilioWebhook('/api/voice/incoming/dial-complete'), (req, res) => {
  const { DialCallStatus } = req.body;
  const conferenceName = req.query.conf;
  const callerPhone = req.query.from || 'unknown';
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    twiml.hangup();
  } else {
    console.log(`incoming: dial-complete fallback (${DialCallStatus}) for ${conferenceName}`);
    appendVoicemailTwiml(twiml, callerPhone);
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /rep-status — Rep's participant leg status changes ────────

router.post('/rep-status', makeTwilioWebhook('/api/voice/incoming/rep-status'), async (req, res) => {
  res.sendStatus(204);

  const { CallStatus, CallSid, ConferenceSid } = req.body;
  const conferenceName = req.query.conf;
  if (!conferenceName) return;

  // Rep answered — enable endConferenceOnExit so hangup by either party
  // cleanly ends the conference (no orphaned conferences).
  if (CallStatus === 'in-progress' && CallSid && ConferenceSid) {
    try {
      await client.conferences(ConferenceSid)
        .participants(CallSid)
        .update({ endConferenceOnExit: true });
      console.log(`incoming: rep joined ${conferenceName} — endConferenceOnExit enabled`);
    } catch (err) {
      console.error('incoming: failed to update rep participant:', err.message);
    }
    return;
  }

  const noAnswer = ['no-answer', 'busy', 'canceled', 'failed'].includes(CallStatus);
  if (!noAnswer) return;

  console.log(`incoming: rep did not answer (${CallStatus}) for ${conferenceName} — redirecting to voicemail`);

  try {
    const { rows } = await pool.query(
      'SELECT caller_call_sid, lead_phone FROM nucleus_phone_calls WHERE conference_name = $1',
      [conferenceName]
    );
    const callerSid = rows[0]?.caller_call_sid;
    const callerPhone = rows[0]?.lead_phone || 'unknown';
    if (!callerSid) {
      console.error('incoming: no caller_call_sid for voicemail redirect');
      return;
    }

    await client.calls(callerSid).update({
      url: `${baseUrl}/api/voice/incoming/voicemail?from=${encodeURIComponent(callerPhone)}`,
      method: 'POST',
    });

    console.log(`incoming: redirected ${callerSid} to voicemail`);
  } catch (err) {
    console.error('incoming: voicemail redirect failed:', err.message);
  }
});

// ─── POST /voicemail — Voicemail TwiML (redirect target) ────────────

router.post('/voicemail', makeTwilioWebhook('/api/voice/incoming/voicemail'), (req, res) => {
  const callerPhone = req.query.from || 'unknown';
  const twiml = new VoiceResponse();
  appendVoicemailTwiml(twiml, callerPhone);
  res.type('text/xml').send(twiml.toString());
});

// ─── POST /voicemail-complete — Save recording URL to DB ────────────

router.post('/voicemail-complete', makeTwilioWebhook('/api/voice/incoming/voicemail-complete'), async (req, res) => {
  res.sendStatus(204);

  const { RecordingUrl, RecordingDuration, CallSid } = req.body;
  const callerPhone = req.query.from || 'unknown';
  if (!RecordingUrl) return;

  console.log(`incoming: voicemail from ${callerPhone} (${RecordingDuration}s)`);

  try {
    await pool.query(
      `UPDATE nucleus_phone_calls
       SET voicemail_url = $1, status = 'voicemail'
       WHERE caller_call_sid = $2`,
      [RecordingUrl, CallSid]
    );

    sendSlackAlert({
      text: `:mailbox_with_mail: Voicemail from ${callerPhone} (${RecordingDuration}s) — check call history`,
    }).catch(() => {});

    const repDm = process.env.INBOUND_REP_SLACK_DM;
    if (repDm) {
      sendSlackDM(repDm,
        `:mailbox_with_mail: Voicemail from ${callerPhone} (${RecordingDuration}s) — check call history`
      ).catch(() => {});
    }
  } catch (err) {
    console.error('incoming: voicemail save failed:', err.message);
  }
});

// ─── POST /fallback — Twilio voice URL fallback ─────────────────────

router.post('/fallback', makeTwilioWebhook('/api/voice/incoming/fallback'), (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. We are experiencing technical difficulties. Please try again in a few minutes.');
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
