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

  // For iOS routes the prefix differentiates the audit trail.
  //
  // Legacy (`INBOUND_CONFERENCE_ARCHITECTURE` unset/false): no Twilio
  // conference is created server-side; the DB row + voicemail callbacks
  // still key off this name as a stable identifier.
  //
  // Phase 2 (`INBOUND_CONFERENCE_ARCHITECTURE=true`): a real Twilio
  // conference IS created — the `-ios` prefix is preserved purely for
  // log-grep continuity with the legacy path.
  const conferenceName = `${iosIdentity ? 'nucleus-inbound-ios' : 'nucleus-inbound'}-${uuidv4()}`;
  const useConferenceArchitecture =
    iosIdentity && process.env.INBOUND_CONFERENCE_ARCHITECTURE === 'true';

  const sink = iosIdentity ? `Client:${iosIdentity}` : forwardTo;
  console.log(`incoming: ${callerPhone} → ${repName} (${sink}) — ${conferenceName}`);

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

  // ─── iOS Conference sink (Phase 2, gated) ────────────────────────
  // INBOUND_CONFERENCE_ARCHITECTURE=true re-routes iOS inbound through a
  // real Twilio conference so the flywheel (recording, RT transcription,
  // equipment / conversation pipelines) runs identically to outbound.
  // Architecture (joruva-dialer-mac plan tender-stargazing-valley.md §
  // Phase 2):
  //   1. Caller TwiML: <Dial><Conference>{name}</Conference></Dial> —
  //      caller enters conference + hold music while we ring iOS.
  //   2. Server fires Twilio REST `calls.create({ to: 'client:<id>', ... })`
  //      → Twilio dispatches a VoIP push to the iOS device via the
  //      existing TVO/PushKit credential. This preserves wake-on-push for
  //      killed apps (Apple requires PushKit pushes to map to real call
  //      events; we can't fake it with Notify).
  //   3. iOS-leg TwiML (returned from `/api/voice/inbound-conference-join`)
  //      contains <Parameter name="conference_name" .../> + <Dial>
  //      <Conference endConferenceOnExit="true">{name}</Conference></Dial>
  //      so the iOS Voice SDK reads the canonical conference name on
  //      receipt of the invite.
  if (useConferenceArchitecture) {
    sendSlackAlert({
      text: `:telephone_receiver: Inbound call from ${callerPhone} → ${repName} (iOS conf)`,
    }).catch(() => {});
    if (repSlackDm) {
      sendSlackDM(repSlackDm,
        `:telephone_receiver: Inbound call from ${callerPhone} — incoming on your iOS dialer`
      ).catch(() => {});
    }

    // Stash conference state so /api/call/status's conference-start
    // handler + recording/transcription pipeline can map by name.
    // direction='inbound' so call.js doesn't try to dial a lead — the
    // caller is already in the conference; only the iOS leg needs to
    // join (which we fire below via calls.create).
    createConference(conferenceName, {
      callerIdentity: 'inbound',
      to: null,
      contactName: callerPhone,
      companyName: null,
      contactId: null,
      dbRowId,
      direction: 'inbound',
      repSlackDm: repSlackDm || '',
      repName: repName || 'Rep',
    });

    // RT transcription — same shape as the PSTN path below + voice.js
    // outbound. partialResults:true is intentional for inbound (matches
    // the PSTN inbound TwiML at line 200-211, NOT voice.js outbound's
    // partialResults:false). The two paths converge on a single
    // transcription stream per conference; both_tracks gives per-leg
    // diarization for the speaker mapping in transcription.js.
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

    // Caller into conference. endConferenceOnExit=false so the caller
    // hanging up does NOT prematurely terminate before voicemail
    // routing; the iOS rep leg's endConferenceOnExit=true (set on the
    // iOS-leg TwiML at /api/voice/inbound-conference-join) handles the
    // rep-hangup termination path.
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

    // Tertiary voicemail safety net if the conference completes with
    // no rep joining (dial-complete handler also catches no-answer).
    appendVoicemailTwiml(twiml, callerPhone, conferenceName);

    // Send caller's TwiML FIRST, then fire the iOS-leg create-call. If
    // calls.create fails (Twilio outage, identity not registered, etc.)
    // the caller is already in the conference with hold music; we
    // terminate the conference to release them, and the dial-complete
    // handler's voicemail TwiML fires when <Dial timeout=35> expires.
    res.type('text/xml').send(twiml.toString());

    // The `to:` query string is the OFFICIAL way to attach customParameters
    // to a REST-initiated CallInvite. Twilio packages these as `twi_params`
    // in the PushKit payload, which the iOS Voice SDK parses into
    // `TVOCallInvite.customParameters` BEFORE the app sees the invite — i.e.
    // synchronously during `handleInvite` (so the CallKit banner can be
    // built with the right caller-phone-derived label without an async
    // lookup). TwiML `<Parameter>` tags only populate customParameters when
    // they're a child of `<Client>` in the DIALING TwiML — there's no
    // dialing TwiML for REST-initiated calls, so the `to:` query string is
    // the sole mechanism. (See Twilio changelog 2020-09-15 and support
    // article 115011213347.)
    //
    // The URL TwiML below is fetched AFTER iOS accepts and is what actually
    // bridges the iOS leg into the conference — it does NOT carry
    // customParameters, only the conference-join verb.
    const joinUrl =
      `${baseUrl}/api/voice/inbound-conference-join` +
      `?conference=${encodeURIComponent(conferenceName)}`;
    const toWithParams =
      `client:${iosIdentity}` +
      `?conference_name=${encodeURIComponent(conferenceName)}` +
      `&call_id=${encodeURIComponent(String(dbRowId))}` +
      `&caller_phone=${encodeURIComponent(callerPhone)}`;
    try {
      await client.calls.create({
        to: toWithParams,
        from: process.env.NUCLEUS_PHONE_NUMBER || callerPhone,
        url: joinUrl,
        method: 'POST',
      });
    } catch (err) {
      console.error('incoming: iOS calls.create failed:', err.message);
      sendSlackAlert({
        text: `:telephone_receiver: inbound conference join failed for ${iosIdentity}: ${err.message} (${conferenceName})`,
      }).catch(() => {});
      // Best-effort: terminate the conference so the caller doesn't sit
      // in hold music indefinitely. The caller's <Dial timeout=35>
      // action URL serves voicemail TwiML if this REST update races.
      try {
        await client.conferences(conferenceName).update({ status: 'completed' });
      } catch (termErr) {
        console.error('incoming: conference terminate failed:', termErr.message);
      }
    }
    return;
  }

  // ─── iOS Client sink (legacy, default) ───────────────────────────
  // Twilio delivers the call as a VoIP push to whatever device registered
  // this identity (zht.3 binding). On accept, Twilio Voice SDK bridges
  // media between caller and iOS — no Twilio conference is created, so
  // the conference flywheel (recording, RT transcription, equipment
  // detection) does NOT run for iOS-only routes. Phase 2's
  // INBOUND_CONFERENCE_ARCHITECTURE=true branch above closes that gap.
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
