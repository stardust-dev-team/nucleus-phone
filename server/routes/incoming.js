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
 *   7. If rep doesn't answer: caller redirected to voicemail
 *
 * Config: INBOUND_FORWARD_NUMBER env var (E.164 format).
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const { VoiceResponse, client } = require('../lib/twilio');
const { pool } = require('../db');
const { createConference } = require('../lib/conference');
const { sendSlackAlert } = require('../lib/slack');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const twilioWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming`,
});

router.post('/', twilioWebhook, async (req, res) => {
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

  console.log(`incoming: ${callerPhone} → conference ${conferenceName} → dial ${forwardTo}`);

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

  // Hold message while rep's phone rings
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
  // startConferenceOnEnter=true → conference starts when caller joins.
  // Status callback will fire conference-start → dials the rep in.
  //
  // Safety: the <Dial> has a 35s timeout. If the rep-status callback
  // fails to redirect the caller, the conference dial will time out
  // and fall through to the voicemail TwiML below.
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
    waitUrl: '',
  }, conferenceName);

  // If the <Dial> times out or completes without the rep, Twilio
  // continues to the next TwiML verb. This is the safety net.
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

  // Slack notification for inbound call
  sendSlackAlert({
    text: `:telephone_receiver: Inbound call from ${callerPhone} — forwarding to rep`,
  }).catch(() => {});

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/dial-complete — Twilio calls this when the
// <Dial><Conference> completes (rep answered + hung up, or timeout).
// If the call was completed normally, just end. If it timed out or
// failed, Twilio continues to the next TwiML verb (voicemail) which
// was already included in the original TwiML response above.
// This action URL is required to prevent Twilio from hanging up after <Dial>.
const dialCompleteWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/dial-complete`,
});

router.post('/dial-complete', dialCompleteWebhook, (req, res) => {
  const { DialCallStatus } = req.body;
  const conferenceName = req.query.conf;
  const callerPhone = req.query.from || 'unknown';
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    // Normal call completion — rep answered and conversation happened
    twiml.hangup();
  } else {
    // Rep didn't answer, busy, or failed — play voicemail
    console.log(`incoming: dial-complete fallback (${DialCallStatus}) for ${conferenceName}`);
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

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/rep-status — Twilio calls this when the rep's
// participant leg changes state. If the rep answers, enable
// endConferenceOnExit so the conference ends cleanly when either party
// hangs up. If the rep doesn't answer, redirect the caller to voicemail.
const repStatusWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/rep-status`,
});

router.post('/rep-status', repStatusWebhook, async (req, res) => {
  res.sendStatus(204);

  const { CallStatus, CallSid, ConferenceSid } = req.body;
  const conferenceName = req.query.conf;
  if (!conferenceName) return;

  // Rep answered — enable endConferenceOnExit so hangup by either party
  // cleanly ends the conference (fixes orphaned conference issue).
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

  // Look up the caller's CallSid so we can redirect their leg
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

    // Redirect the caller's call leg to voicemail TwiML
    await client.calls(callerSid).update({
      url: `${baseUrl}/api/voice/incoming/voicemail?from=${encodeURIComponent(callerPhone)}`,
      method: 'POST',
    });

    console.log(`incoming: redirected ${callerSid} to voicemail`);
  } catch (err) {
    console.error('incoming: voicemail redirect failed:', err.message);
  }
});

// POST /api/voice/incoming/voicemail — TwiML that plays a message and records.
// The caller lands here when redirected out of the conference.
const voicemailWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/voicemail`,
});

router.post('/voicemail', voicemailWebhook, (req, res) => {
  const callerPhone = req.query.from || 'unknown';
  const twiml = new VoiceResponse();

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

  res.type('text/xml').send(twiml.toString());
});

// POST /api/voice/incoming/voicemail-complete — saves voicemail recording URL to the call record
const vmCompleteWebhook = twilio.webhook({
  validate: process.env.NODE_ENV === 'production',
  url: `${baseUrl}/api/voice/incoming/voicemail-complete`,
});

router.post('/voicemail-complete', vmCompleteWebhook, async (req, res) => {
  res.sendStatus(204);

  const { RecordingUrl, RecordingSid, RecordingDuration, CallSid } = req.body;
  const callerPhone = req.query.from || 'unknown';
  if (!RecordingUrl) return;

  console.log(`incoming: voicemail from ${callerPhone} (${RecordingDuration}s) — ${RecordingSid}`);

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
  } catch (err) {
    console.error('incoming: voicemail save failed:', err.message);
  }
});

// POST /api/voice/incoming/fallback — Twilio hits this if the primary
// voice URL is down. Better than Twilio's generic error message.
router.post('/fallback', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. We are experiencing technical difficulties. Please try again in a few minutes.');
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
