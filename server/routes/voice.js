const { Router } = require('express');
const { VoiceResponse, client } = require('../lib/twilio');
const { pool } = require('../db');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');
const { sendSystemAlert } = require('../lib/slack');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook();
const simBridgeWebhook = makeTwilioWebhook();

// Window during which a Vapi inbound leg may correlate to a pending sim row.
// Conference-start handler stamps conference_sid_set_at, Vapi typically dials
// into NUCLEUS_SIM_CONFERENCE_NUMBER within 2-5s; 30s gives generous slack
// for Vapi-side queuing without admitting stale rows whose conferences have
// already failed.
const SIM_BRIDGE_CORRELATION_WINDOW_SECONDS = 30;

// POST /api/voice — TwiML webhook called by Twilio when PWA connects via Voice SDK
router.post('/', twilioWebhook, async (req, res) => {
  touch('twilio.webhook');
  logEvent('webhook', 'twilio.voice', `TwiML request: action=${req.body.Action || 'initiate'}, conf=${req.body.ConferenceName || 'none'}`);
  try {
    const { ConferenceName, Action, Muted } = req.body;
    const twiml = new VoiceResponse();

    if (Action === 'join') {
      const dial = twiml.dial();
      dial.conference({
        startConferenceOnEnter: false,
        endConferenceOnExit: false,
        muted: Muted === 'true',
        beep: false,
      }, ConferenceName);

      return res.type('text/xml').send(twiml.toString());
    }

    // Default: "initiate" — caller enters conference.
    // Lead dialing happens in the conference-start status callback (call.js),
    // NOT here. This eliminates the race condition of polling for the conference SID.

    // Save caller's CallSid for RT transcription webhook mapping.
    // The transcription webhook receives CallSid but the app tracks by
    // conference_name. This bridges the gap without in-memory cache
    // (which would be lost on Render restart).
    const updateResult = await pool.query(
      'UPDATE nucleus_phone_calls SET caller_call_sid = $1 WHERE conference_name = $2',
      [req.body.CallSid, ConferenceName]
    );
    if (updateResult.rowCount === 0) {
      console.warn(`voice: caller_call_sid UPDATE matched 0 rows for conference ${ConferenceName}`);
    }

    // Enable Twilio Real-Time Transcription (only in initiator's TwiML, not
    // join participants — one transcription stream per conference is sufficient).
    // If RT Transcription isn't enabled on the account, this verb is silently ignored.
    //
    // joruva-dialer-mac-djy: `partialResults: false`. Twilio's RT
    // Transcription with partial results enabled emits the running
    // transcription as it builds up — one utterance becomes 5+
    // webhooks ("A." → "A lot." → "A lot of." → …). The server
    // broadcasts every chunk to subscribers; iOS appends each to the
    // live transcript box, rendering the same utterance multiple
    // times with progressive expansion. End-state UX: transcript is
    // unreadable after 30s of conversation. With `partialResults:
    // false`, Twilio buffers until utterance is complete (~500ms-1s
    // latency tradeoff) and emits one webhook per finalized utterance
    // per speaker leg. Acceptable latency for the live cockpit's
    // read-by-rep use case.
    //
    // `track: 'both_tracks'` is preserved — that's per-speaker
    // diarization, not the dedup problem. The "both tracks doubling
    // when devices are co-located" subset of the original bd-djy
    // symptom is out of scope (separate bead if it ever materially
    // affects UX).
    const start = twiml.start();
    start.transcription({
      statusCallbackUrl: `${baseUrl}/api/transcription`,
      statusCallbackMethod: 'POST',
      track: 'both_tracks',
      languageCode: 'en-US',
      partialResults: false,
      intelligenceService: process.env.TWILIO_INTELLIGENCE_SERVICE_SID || undefined,
    });

    const dial = twiml.dial({ callerId: process.env.NUCLEUS_PHONE_NUMBER });
    dial.conference({
      record: 'record-from-start',
      recordingStatusCallback: `${baseUrl}/api/call/recording-status`,
      recordingStatusCallbackEvent: 'completed',
      statusCallback: `${baseUrl}/api/call/status`,
      statusCallbackEvent: 'start end join leave',
      startConferenceOnEnter: true,
      // Outbound iOS-leg only — this `voice.js` `Action='initiate'`
      // TwiML path is only reached for outbound calls (inbound iOS legs
      // are connected via `<Client>tom</Client>` from `incoming.js`'s
      // TwiML, which doesn't go through here). Hardcoding `true` is safe
      // for outbound: when the rep ends the call, the conference dies
      // and the lead leg drops, matching how the lead-leg flag works
      // (`call.js:327` uses `!isInbound`). If a future refactor pushes
      // inbound flows through this same TwiML, this becomes WRONG (the
      // rep hanging up mid-voicemail-leave would cut the caller off);
      // pin the assumption rather than mirror call.js blindly. Closes
      // joruva-dialer-mac-lkk's leak path where iOS End Call dropped its
      // leg but the lead leg + recording kept running until idle timeout.
      endConferenceOnExit: true,
      beep: false,
    }, ConferenceName);

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('voice: error generating TwiML:', err.message);
    // Return valid TwiML even on error — Twilio will hang up with an empty response
    const twiml = new VoiceResponse();
    twiml.say('An error occurred. Please try again.');
    res.type('text/xml').send(twiml.toString());
  }
});

/** Build the conference TwiML for a matched sim row. Vapi's leg is the
 *  second participant joining `sim-{id}`; endConferenceOnExit:true on this
 *  leg means Vapi hanging up tears down the conference, dropping the rep's
 *  leg cleanly into the scoring sheet. */
function buildSimConferenceTwiml(simRowId) {
  const twiml = new VoiceResponse();
  twiml.dial().conference({
    endConferenceOnExit: true,
    startConferenceOnEnter: true,
    beep: false,
  }, `sim-${simRowId}`);
  return twiml.toString();
}

// Allowed characters in a conference name passed via query param. Matches the
// regex sim-smoke-leg.js uses client-side; the server validates independently
// because URL-bound input is an untrusted boundary.
const SIM_BRIDGE_CONF_RE = /^[A-Za-z0-9_-]+$/;

/** Build conference TwiML for the REP leg of a sim bridge smoke. Mirrors what
 *  sim-smoke-leg.js used to emit inline, but rendered server-side so that
 *  Twilio honors the <Conference statusCallback> attributes (nucleus-phone-ufne
 *  hypothesis 1: inline TwiML via Calls.create({twiml}) drops the conference
 *  statusCallback; url= delivery does not). */
function buildSimRepConferenceTwiml(conferenceName, statusCallback) {
  const twiml = new VoiceResponse();
  twiml.dial().conference({
    endConferenceOnExit: true,
    startConferenceOnEnter: true,
    beep: false,
    statusCallback,
    statusCallbackEvent: 'start end',
    statusCallbackMethod: 'POST',
  }, conferenceName);
  return twiml.toString();
}

/**
 * GET /api/voice/sim-bridge-twiml — TwiML endpoint used by the smoke-test
 * dialer (scripts/sim-smoke-leg.js) for the rep leg of a sim conference. The
 * dialer calls Calls.create({ url: `${BASE_URL}/api/voice/sim-bridge-twiml?conf=...` })
 * instead of `{ twiml: '...' }` so that Twilio honors the inline
 * <Conference statusCallback> attribute (server-returned TwiML is the working
 * path; inline TwiML via REST appears to drop the conference-level callback).
 *
 * Query params (Twilio fetches via POST by default, so params land on the
 * URL string — the smoke dialer constructs the URL with conf+sc embedded):
 *   conf — required. Conference name. Must match SIM_BRIDGE_CONF_RE.
 *   sc   — optional. Conference statusCallback URL. Defaults to the prod
 *          /api/call/status endpoint. Must be https://.
 *
 * Accepted via both GET and POST: Twilio's default is POST, but local curl
 * smoke / manual inspection is more ergonomic via GET. No signature
 * validation: this endpoint emits TwiML that's safe regardless of caller
 * (the conf name is sanitized; the sc URL is constrained to https://).
 */
function handleSimBridgeTwiml(req, res) {
  touch('twilio.sim-bridge-twiml');
  const conf = String(req.query.conf || '');
  if (!conf || !SIM_BRIDGE_CONF_RE.test(conf)) {
    const twiml = new VoiceResponse();
    twiml.say('Invalid conference name.');
    twiml.hangup();
    return res.status(400).type('text/xml').send(twiml.toString());
  }

  const sc = typeof req.query.sc === 'string' && req.query.sc.startsWith('https://')
    ? req.query.sc
    : `${baseUrl}/api/call/status`;

  res.type('text/xml').send(buildSimRepConferenceTwiml(conf, sc));
}

router.get('/sim-bridge-twiml', handleSimBridgeTwiml);
router.post('/sim-bridge-twiml', handleSimBridgeTwiml);

/** Failure TwiML for the bridge endpoint. No <Say> — Vapi's the listener
 *  here, not a human, so TTS would just delay the hangup by 3-5s of robot
 *  apology and waste Vapi minutes. */
function buildSimBridgeFailureTwiml() {
  const twiml = new VoiceResponse();
  twiml.hangup();
  return twiml.toString();
}

/**
 * POST /api/voice/sim-bridge — Twilio inbound webhook on
 * NUCLEUS_SIM_CONFERENCE_NUMBER. Vapi places an outbound call to this number
 * after the conference-start handler in routes/call.js fires; we must
 * conference Vapi's leg into the right `sim-{simCallId}` conference.
 *
 * Correlation strategy (v1, option 1 from joruva-dialer-mac-8rx): time-window
 * DB lookup. Vapi's `assistantOverrides.variableValues` are internal to Vapi
 * and not surfaced to Twilio's inbound webhook, so the only available join
 * key is "the most recently-bridged sim row that hasn't been claimed yet."
 *
 * Concurrency: SELECT FOR UPDATE SKIP LOCKED + the twilio_vapi_leg_sid
 * sentinel makes this deterministic up to N concurrent unbridged sims —
 * each inbound webhook picks a distinct row because locked rows are skipped
 * rather than blocked. At ~75 practice calls/day across 5 reps the window
 * for two unbridged-and-unclaimed rows to coexist is bounded by Vapi's
 * dial latency (typically <5s), so collisions remain near-zero.
 *
 * Retry idempotency: Twilio retries a 5xx/slow webhook with the SAME
 * CallSid. Without the idempotency check, retry #2 sees row A already
 * claimed (its twilio_vapi_leg_sid is set) and grabs an unrelated row B —
 * which then has Vapi bridging into the wrong rep's conference. The
 * SELECT-by-CallSid at the top closes that hole for sequential retries
 * (the common case). Concurrent retries are essentially impossible given
 * Twilio's 15s timeout vs. our sub-second response, so we don't try to
 * close that window separately.
 *
 * Failure mode: no matching row → ALSO end the rep's stuck conference.
 * The rep's iOS leg is sitting in `sim-{id}` waiting for a second
 * participant; nothing exits to trigger endConferenceOnExit, so without
 * an active kill the rep would sit in silence until stale-sweep runs.
 * We look up the most recent unbridged conference_sid (read-only, no
 * claim) and complete it. The diagnostic Slack alert distinguishes
 * "candidate row outside window" from "no candidates at all" so the
 * operator knows whether to bump the window or look upstream.
 */
router.post('/sim-bridge', simBridgeWebhook, async (req, res) => {
  touch('twilio.sim-bridge');
  const callSid = req.body.CallSid || null;
  const from = req.body.From || null;
  logEvent('webhook', 'twilio.sim-bridge', `inbound CallSid=${callSid} From=${from}`);

  let dbClient = null;
  try {
    dbClient = await pool.connect();
    await dbClient.query('BEGIN');

    // Retry idempotency: if this CallSid already claimed a row, return TwiML
    // for that same row. Twilio sends the identical CallSid on retries; the
    // first response may have raced past Twilio's timeout. Without this,
    // the retry steals a neighboring sim's row.
    if (callSid) {
      const { rows: existing } = await dbClient.query(
        `SELECT id FROM sim_call_scores WHERE twilio_vapi_leg_sid = $1 LIMIT 1`,
        [callSid]
      );
      if (existing.length) {
        await dbClient.query('COMMIT');
        const simRowId = existing[0].id;
        logEvent('webhook', 'twilio.sim-bridge', `retry-idempotent CallSid=${callSid} → sim-${simRowId}`);
        console.log(`sim-bridge: retry CallSid=${callSid} → sim-${simRowId} (idempotent)`);
        return res.type('text/xml').send(buildSimConferenceTwiml(simRowId));
      }
    }

    const { rows } = await dbClient.query(
      `SELECT id
         FROM sim_call_scores
        WHERE vapi_call_id IS NOT NULL
          AND conference_sid IS NOT NULL
          AND twilio_vapi_leg_sid IS NULL
          AND status = 'in-progress'
          AND conference_sid_set_at > NOW() - make_interval(secs => $1)
        ORDER BY conference_sid_set_at DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [SIM_BRIDGE_CORRELATION_WINDOW_SECONDS]
    );

    if (!rows.length) {
      // Diagnostic: count unbridged candidates ignoring the time window.
      // Distinguishes "conference-start handler never fired" (count=0,
      // look upstream) from "window too tight" (count>0, bump it).
      const { rows: diagRows } = await dbClient.query(
        `SELECT id, conference_sid, conference_sid_set_at
           FROM sim_call_scores
          WHERE vapi_call_id IS NOT NULL
            AND conference_sid IS NOT NULL
            AND twilio_vapi_leg_sid IS NULL
            AND status = 'in-progress'
          ORDER BY conference_sid_set_at DESC
          LIMIT 5`
      );
      await dbClient.query('COMMIT');

      // Actively end the rep's stuck conference if we can find one. No
      // claim — purely a cleanup of the orphaned conference. Without this
      // the rep sits in silence until stale-sweep fires (30-60s).
      const stuckRow = diagRows[0];
      if (stuckRow && stuckRow.conference_sid) {
        client.conferences(stuckRow.conference_sid).update({ status: 'completed' })
          .then(() => console.log(`sim-bridge: ended stuck conference ${stuckRow.conference_sid} for sim ${stuckRow.id}`))
          .catch((endErr) => console.error(`sim-bridge: failed to end stuck conference ${stuckRow.conference_sid}:`, endErr.message));
      }

      const candidateCount = diagRows.length;
      console.warn(`sim-bridge: no correlatable sim row for CallSid=${callSid} (window=${SIM_BRIDGE_CORRELATION_WINDOW_SECONDS}s, unbridged_candidates=${candidateCount})`);
      const diagText = candidateCount === 0
        ? `*Diagnosis:* no unbridged candidates at all — conference-start handler likely never fired. Look upstream in \`call.js:handleSimConferenceStart\`.`
        : `*Diagnosis:* ${candidateCount} unbridged candidate row(s) exist outside the ${SIM_BRIDGE_CORRELATION_WINDOW_SECONDS}s window — Vapi dial latency exceeded the window. Most recent: sim id=${stuckRow.id}, conference_sid_set_at=${stuckRow.conference_sid_set_at}.`;
      sendSystemAlert(
        `🔴 Sim Bridge — no correlatable row`,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `Vapi inbound CallSid \`${callSid}\` from \`${from}\` could not be matched.\n\n${diagText}` },
        }]
      ).catch((alertErr) => console.error('sim-bridge: Slack alert failed:', alertErr.message));
      return res.type('text/xml').send(buildSimBridgeFailureTwiml());
    }

    const simRowId = rows[0].id;
    const updateResult = await dbClient.query(
      `UPDATE sim_call_scores SET twilio_vapi_leg_sid = $1 WHERE id = $2`,
      [callSid, simRowId]
    );
    if (updateResult.rowCount !== 1) {
      // SELECT FOR UPDATE held the lock; no other writer could have touched
      // this row inside our transaction. rowCount !== 1 means the row
      // vanished between SELECT and UPDATE, which is impossible under
      // current semantics. Throw to ROLLBACK rather than ship inconsistent
      // TwiML — caller's catch handles the rollback + alert.
      throw new Error(`claim UPDATE affected ${updateResult.rowCount} rows for sim ${simRowId} (expected 1)`);
    }
    await dbClient.query('COMMIT');

    logEvent('webhook', 'twilio.sim-bridge', `matched simCallId=${simRowId} → conference=sim-${simRowId}`);
    console.log(`sim-bridge: CallSid=${callSid} → sim-${simRowId}`);
    res.type('text/xml').send(buildSimConferenceTwiml(simRowId));
  } catch (err) {
    console.error('sim-bridge: error:', err.message);
    if (dbClient) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    }
    sendSystemAlert(
      `🔴 Sim Bridge — handler exception`,
      [{
        type: 'section',
        text: { type: 'mrkdwn', text: `\`/api/voice/sim-bridge\` threw for CallSid \`${callSid}\`: ${err.message}` },
      }]
    ).catch((alertErr) => console.error('sim-bridge: Slack alert failed:', alertErr.message));
    res.type('text/xml').send(buildSimBridgeFailureTwiml());
  } finally {
    if (dbClient) dbClient.release();
  }
});

module.exports = router;
