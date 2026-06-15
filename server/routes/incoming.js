/**
 * incoming.js — Handles inbound calls to Nucleus Phone numbers.
 *
 * Routes inbound calls through the same conference architecture as outbound
 * calls so they get recording, RT transcription, Fireflies upload, equipment
 * detection, AI summary, and UCIL sync — the full Nucleus flywheel.
 *
 * Supports multiple inbound numbers, each routed to a different rep. A route
 * may sink to either a PSTN forward number OR an iOS Twilio Client identity
 * (registered via /api/voice-push/register).
 *
 * Canonical config: server/config/team.json (committed, non-PII metadata)
 * merged with server/config/team-phones.json (gitignored, mobile numbers)
 * via server/lib/team-registry.js. Edit team.json to add/change a rep's
 * inbound DID or route type; the registry validates schema at boot.
 *
 * Inbound routing entry on each rep: { did, type: 'forward'|'iosIdentity',
 * iosIdentity?: string }. Drift sentinels in
 * __tests__/team-registry.conformance.test.js pin the Ryann + Tom mappings.
 *
 * Falls back to INBOUND_FORWARD_NUMBER env var for the legacy
 * single-number-mode backstop only (no team.json equivalent).
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const { VoiceResponse, client } = require('../lib/twilio');
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const { pool } = require('../db');
const { createConference, getConference } = require('../lib/conference');
const { sendSlackAlert, sendSlackDM } = require('../lib/slack');
const { loadRegistryOrExit } = require('../lib/team-registry');
const { attachSttVerbs } = require('../lib/stt-twiml');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';

// Load routes from the canonical team-registry at module init via the
// shared fail-loud wrapper — same behavior at all three consumers
// (incoming.js, escalation.js, sim.js) so a corrupt team.json crashes
// boot consistently rather than producing a half-healthy deploy.
const inboundRoutes = loadRegistryOrExit('incoming').getAllInboundRoutes();

/**
 * Resolve which rep to route to based on the called number.
 * Returns the route entry { forward?, iosIdentity?, slack, name } or null.
 * When both sinks are present on one entry, the caller should prefer
 * iosIdentity (Twilio Client) over forward (PSTN).
 */
function resolveRoute(calledNumber) {
  // Try exact match in INBOUND_ROUTES
  if (calledNumber && inboundRoutes[calledNumber]) {
    return inboundRoutes[calledNumber];
  }
  // Fallback to legacy single-number config
  const legacy = process.env.INBOUND_FORWARD_NUMBER;
  if (legacy) {
    return {
      forward: legacy,
      slack: process.env.INBOUND_REP_SLACK_DM || '',
      name: 'Rep',
    };
  }
  return null;
}

/**
 * Append voicemail TwiML (say + record + goodbye) to a VoiceResponse.
 * Used by three paths: inline safety net, dial-complete fallback, and
 * rep-status redirect. Kept in one place to avoid drift.
 */
function appendVoicemailTwiml(twiml, callerPhone, conferenceName) {
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. No one is available to take your call right now. Please leave a message after the tone and we will get back to you as soon as possible.');
  let cbUrl = `${baseUrl}/api/voice/incoming/voicemail-complete?from=${encodeURIComponent(callerPhone)}`;
  if (conferenceName) cbUrl += `&conf=${encodeURIComponent(conferenceName)}`;
  twiml.record({
    maxLength: 180,
    playBeep: true,
    recordingStatusCallback: cbUrl,
    recordingStatusCallbackEvent: 'completed',
    recordingStatusCallbackMethod: 'POST',
  });
  twiml.say('We did not receive a message. Goodbye.');
}

// ─── POST / — Initial inbound call handler ──────────────────────────

router.post('/', makeTwilioWebhook(), async (req, res) => {
  const calledNumber = req.body.To || req.body.Called;
  const route = resolveRoute(calledNumber);
  const twiml = new VoiceResponse();

  if (!route) {
    console.error('incoming: no route for', calledNumber);
    twiml.say('Thank you for calling Joruva. We are currently unavailable. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  const iosIdentity = route.iosIdentity;
  const forwardTo = route.forward;
  const repName = route.name;
  const repSlackDm = route.slack;

  const callerPhone = req.body.From || 'unknown';
  const callerCallSid = req.body.CallSid;

  if (!callerCallSid) {
    console.error('incoming: no CallSid in webhook body');
    twiml.say('Thank you for calling Joruva. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  // For iOS routes the prefix differentiates the audit trail — no Twilio
  // conference is created server-side, but the DB row + voicemail callbacks
  // still key off this name as a stable identifier.
  const conferenceName = `${iosIdentity ? 'nucleus-inbound-ios' : 'nucleus-inbound'}-${uuidv4()}`;

  const sink = iosIdentity ? `Client:${iosIdentity}` : forwardTo;
  console.log(`incoming: ${callerPhone} → ${repName} (${sink}) — ${conferenceName}`);

  // Create DB row — same schema as outbound, but direction='inbound' and
  // lead_phone stores the CALLER's number (for identity resolution).
  let dbRowId;
  try {
    const result = await pool.query(
      // Stamp the per-call in-house-STT gate in the SAME INSERT (plan review #2). The
      // caller_identity is the literal 'inbound', so the rep's toggle is looked up by the
      // RESOLVED rep's canonical identity (route.identity — UNIQUE, present on BOTH iOS and
      // forward routes), NOT display_name (which is cosmetic and drifts from team.json's
      // `name`, silently no-op'ing the flag for full-name reps). No user row → COALESCE → FALSE.
      `INSERT INTO nucleus_phone_calls
        (conference_name, caller_identity, caller_call_sid, lead_phone, direction, use_inhouse_stt)
       VALUES ($1, $2, $3, $4, 'inbound',
         COALESCE((SELECT use_inhouse_stt FROM nucleus_phone_users WHERE identity = $5), FALSE))
       RETURNING id`,
      [conferenceName, 'inbound', callerCallSid, callerPhone, route.identity]
    );
    dbRowId = result.rows[0].id;
  } catch (err) {
    console.error('incoming: DB insert failed:', err.message);
    twiml.say('Thank you for calling Joruva. We are experiencing technical difficulties. Please try again later.');
    return res.type('text/xml').send(twiml.toString());
  }

  // ─── iOS Client sink ─────────────────────────────────────────────
  // Twilio delivers the call as a VoIP push to whatever device registered
  // this identity (zht.3 binding). On accept, Twilio Voice SDK bridges
  // media between caller and iOS — no Twilio conference is created, so
  // the conference flywheel (recording, RT transcription, equipment
  // detection) does NOT run for iOS-only routes. Future iOS-flywheel work
  // (separate bead) would re-route inbound through a conference and have
  // iOS join via Voice SDK Connect rather than direct Client dial.
  if (iosIdentity) {
    sendSlackAlert({
      text: `:telephone_receiver: Inbound call from ${callerPhone} → ${repName} (iOS)`,
    }).catch(() => {});
    if (repSlackDm) {
      sendSlackDM(repSlackDm,
        `:telephone_receiver: Inbound call from ${callerPhone} — incoming on your iOS dialer`
      ).catch(() => {});
    }

    const dial = twiml.dial({
      callerId: callerPhone,
      timeout: 30,
      action: `${baseUrl}/api/voice/incoming/dial-complete?conf=${encodeURIComponent(conferenceName)}&from=${encodeURIComponent(callerPhone)}`,
    });
    // <Client> child node so we can attach <Parameter> children (TwiML
    // Client supports custom parameters that surface to the Voice SDK as
    // CallInvite.customParameters). dialer-mac bd-upq.17 reads `call_id`
    // on the iOS side to populate Phase G's DispositionSheet after the
    // inbound call ends — without this, the sheet has no way to map the
    // CallInvite back to the DB row.
    const clientNode = dial.client(iosIdentity);
    clientNode.parameter({ name: 'call_id', value: String(dbRowId) });

    appendVoicemailTwiml(twiml, callerPhone, conferenceName);
    return res.type('text/xml').send(twiml.toString());
  }

  // ─── PSTN/conference sink (unchanged) ────────────────────────────
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
    direction: 'inbound',
    repSlackDm: repSlackDm || '',
    repName: repName || 'Rep',
  });

  // Hold message so the caller doesn't hear silence while rep's phone rings
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. Please hold while we connect you.');

  // Attach the STT <Start> verbs (nucleus-phone-rgja.7) — same as outbound voice.js:
  // Twilio RT <Transcription> (gated on STT_FALLBACK_TWILIO, default on) + the in-house
  // <Stream both_tracks> + conference_name <Parameter> (only when STT_WS_URL is set).
  // partialResults:false rationale + dual-run gating live in lib/stt-twiml.js.
  // NOTE: this is the PSTN/conference path ONLY. The iOS-inbound <Dial><Client> path
  // above gets NO <Stream> yet — that's gated on the B0 track-mapping spike (rgja.3/.8).
  attachSttVerbs(twiml, { conferenceName, baseUrl });

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
  appendVoicemailTwiml(twiml, callerPhone, conferenceName);

  // Slack: alert admin channel + DM the rep with cockpit deep link
  const cockpitUrl = `${baseUrl}/cockpit/${encodeURIComponent(callerPhone)}?conf=${encodeURIComponent(conferenceName)}`;
  sendSlackAlert({
    text: `:telephone_receiver: Inbound call from ${callerPhone} → ${repName}`,
  }).catch(() => {});

  if (repSlackDm) {
    sendSlackDM(repSlackDm,
      `:telephone_receiver: Inbound call from ${callerPhone}\n<${cockpitUrl}|Open Cockpit>`
    ).catch(() => {});
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /dial-complete — <Dial> action URL (safety net) ───────────

router.post('/dial-complete', makeTwilioWebhook(), (req, res) => {
  const { DialCallStatus } = req.body;
  const conferenceName = req.query.conf;
  const callerPhone = req.query.from || 'unknown';
  const conf = conferenceName ? getConference(conferenceName) : null;
  if (conferenceName && !conf) console.warn(`incoming: dial-complete: conference ${conferenceName} already swept`);
  const repSlack = conf?.repSlackDm || '';
  const twiml = new VoiceResponse();

  if (DialCallStatus === 'completed') {
    twiml.hangup();
  } else {
    console.log(`incoming: dial-complete fallback (${DialCallStatus}) for ${conferenceName}`);
    appendVoicemailTwiml(twiml, callerPhone, conferenceName);
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── POST /rep-status — Rep's participant leg status changes ────────

router.post('/rep-status', makeTwilioWebhook(), async (req, res) => {
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

    const conf = getConference(conferenceName);
    const repSlack = conf?.repSlackDm || '';
    await client.calls(callerSid).update({
      url: `${baseUrl}/api/voice/incoming/voicemail?from=${encodeURIComponent(callerPhone)}&conf=${encodeURIComponent(conferenceName)}`,
      method: 'POST',
    });

    console.log(`incoming: redirected ${callerSid} to voicemail`);
  } catch (err) {
    console.error('incoming: voicemail redirect failed:', err.message);
  }
});

// ─── POST /voicemail — Voicemail TwiML (redirect target) ────────────

router.post('/voicemail', makeTwilioWebhook(), (req, res) => {
  const callerPhone = req.query.from || 'unknown';
  const conferenceName = req.query.conf;
  if (conferenceName && !getConference(conferenceName)) console.warn(`incoming: voicemail: conference ${conferenceName} already swept`);
  const twiml = new VoiceResponse();
  appendVoicemailTwiml(twiml, callerPhone, conferenceName);
  res.type('text/xml').send(twiml.toString());
});

// ─── POST /voicemail-complete — Save recording URL to DB ────────────

router.post('/voicemail-complete', makeTwilioWebhook(), async (req, res) => {
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

    const conferenceName = req.query.conf;
    const conf = conferenceName ? getConference(conferenceName) : null;
    if (conferenceName && !conf) console.warn(`incoming: voicemail-complete: conference ${conferenceName} already swept`);
    const repDm = conf?.repSlackDm || '';
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

router.post('/fallback', makeTwilioWebhook(), (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({
    voice: 'Polly.Joanna',
  }, 'Thank you for calling Joruva Industrial. We are experiencing technical difficulties. Please try again in a few minutes.');
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
