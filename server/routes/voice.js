const { Router } = require('express');
const { VoiceResponse, client } = require('../lib/twilio');
const { pool } = require('../db');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');
const { sendSystemAlert } = require('../lib/slack');
const { redeemJoinTicket } = require('../lib/join-tickets');
const { getConference } = require('../lib/conference');
const { resolveCallerIdentity } = require('../lib/twilio-caller-identity');

const router = Router();

const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const { makeTwilioWebhook } = require('../lib/twilio-webhook');
const twilioWebhook = makeTwilioWebhook();
const simBridgeWebhook = makeTwilioWebhook();

// jsec-r0k6: refusals are a security signal, so they alert — but an alert an
// attacker can trigger on demand is an alert channel an attacker can flood, and
// the likelier cause is dull: one browser holding a pre-deploy JS bundle firing
// one 🔴 per retry. Collapse repeats of the same (reason, conference) pair into
// one alert per window. Refusals are ALWAYS logged; only the Slack call is
// throttled, so throttling can never hide an event from the record.
const REFUSAL_ALERT_WINDOW_MS = 5 * 60 * 1000;
const lastRefusalAlertAt = new Map();

function shouldAlertOnRefusal(key, now = Date.now()) {
  const previous = lastRefusalAlertAt.get(key);
  if (previous !== undefined && now - previous < REFUSAL_ALERT_WINDOW_MS) return false;
  lastRefusalAlertAt.set(key, now);
  // Bound the map: an attacker cycling conference names must not grow it
  // without limit. These entries are pure rate-limiter state — dropping the
  // oldest costs at most one extra alert.
  if (lastRefusalAlertAt.size > 500) {
    const oldest = lastRefusalAlertAt.keys().next().value;
    lastRefusalAlertAt.delete(oldest);
  }
  return true;
}

/**
 * Refuse to place a caller into a conference, on either branch of POST /api/voice.
 *
 * 403 rather than 200-with-hangup: Twilio does not render TwiML on a non-2xx,
 * so the <Say> is for a human reading the response body, not for the caller.
 * The status code is the point — a refusal surfaces as a Twilio 11200 in the
 * account's own error log instead of looking like a normal completed call.
 * (POST /api/voice/sim-bridge-twiml makes the same trade with a 400.)
 */
function refuseConferenceEntry(res, branch, reason, detail) {
  // caller= is the most useful field in this line and is trustworthy (jsec-gsx0):
  // it comes from Twilio's From, not from anything the caller chose.
  console.warn(`voice: ${branch} REFUSED (${reason}) caller=${detail.caller || '(unidentified)'} conference=${detail.requestedConference || detail.conference || '(none)'} callSid=${detail.callSid || '(none)'}`);
  logEvent('error', 'twilio.voice', `${branch} REFUSED: ${reason}`, { level: 'error', detail });

  const alertKey = detail.alertKey || `${branch}:${detail.requestedConference || detail.conference || '(none)'}`;
  if (shouldAlertOnRefusal(alertKey)) {
    const body = detail.alertText
      || 'Expected volume is zero. A burst means either a client that predates jsec-r0k6, or someone probing the conference paths.';
    sendSystemAlert(
      '🔴 Nucleus Phone — conference entry refused',
      [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `A \`/api/voice\` **${branch}** was refused: ${reason}.\n`
            + `Conference: \`${detail.requestedConference || detail.conference || '(none)'}\`\nCallSid: \`${detail.callSid || '(none)'}\`\n\n`
            + `${body} `
            + `Repeats for this cause are suppressed for ${REFUSAL_ALERT_WINDOW_MS / 60000} minutes; the server log has every occurrence.`,
        },
      }]
    ).catch((alertErr) => console.error('voice: refusal Slack alert failed:', alertErr.message));
  }

  const refused = new VoiceResponse();
  refused.say('This call cannot be joined.');
  refused.hangup();
  return res.status(403).type('text/xml').send(refused.toString());
}

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
    // `Muted` is intentionally NOT destructured: on the join path it now comes
    // from the ticket, and on the initiate path it was never used. Leaving it
    // bound here would invite a future edit to read it back into the TwiML.
    const { ConferenceName, Action } = req.body;
    const twiml = new VoiceResponse();

    // jsec-gsx0: who is on this leg. Read from the REST Call resource, NOT from
    // req.body.From.
    //
    // The body param looks identical and is identical on every legitimate call —
    // which is precisely why it is the wrong thing to trust.
    // `Device.connect({params})` puts client-supplied keys into this same flat
    // POST body, and Twilio documents that those params are not safe. Whether a
    // custom `From` overrides the standard one is undocumented; the REST
    // resource makes the answer irrelevant. (The first draft of this change read
    // the body param, justified by a survey of production calls — which proved
    // what `From` looks like, not whether a caller can set it. Caught in review.)
    //
    // Cost: one Twilio REST round-trip per request to this route. Acceptable —
    // the route is only reachable by Voice SDK legs (it is the voice URL of one
    // TwiML App, and no phone number points at it), and routes/call.js already
    // requires the Twilio REST API to dial the lead in, so this introduces no
    // new outage class. Fails CLOSED on an API error.
    const {
      identity: callerIdentity, error: identityError, infrastructure,
    } = await resolveCallerIdentity(client, req.body.CallSid);
    if (!callerIdentity) {
      return refuseConferenceEntry(res, Action === 'join' ? 'join' : 'initiate', `could not establish caller identity — ${identityError}`, {
        requestedConference: ConferenceName || null,
        callSid: req.body.CallSid || null,
        // A Twilio REST degradation refuses every in-flight call, and every one
        // has a different conference name — so the usual per-conference alert
        // key would emit one "someone is probing" alert PER CALL during an
        // outage. Collapse infrastructure failures onto a single key with
        // honest wording; they are the likeliest refusal on this route and they
        // are not an attack.
        alertKey: infrastructure ? 'identity-lookup-unavailable' : undefined,
        alertText: infrastructure
          ? 'Callers could not be identified because the Twilio lookup failed, so conference entry is being refused. This is an INFRASTRUCTURE failure, not a probe — outbound calls are affected. Alerts for this cause are collapsed to one.'
          : undefined,
      });
    }

    if (Action === 'join') {
      // jsec-r0k6: this is the REAL join — the one that puts a second pair of
      // ears into a live customer call. It used to conference the caller into
      // whatever `ConferenceName` the request carried. This request comes from
      // Twilio, so it has no session and no req.user; there was nothing here to
      // authorize against and any authenticated principal could silently land
      // in any rep's call by naming their conference.
      //
      // The conference is now resolved from a server-minted ticket (see
      // lib/join-tickets.js) issued by POST /api/call/join, which DOES have a
      // session and checks admin-or-owner before minting. `ConferenceName` and
      // `Muted` from this request body are deliberately IGNORED on this path —
      // reading either one back would re-open the hole.
      // jsec-gsx0: the ticket must ALSO have been issued to this caller.
      // Redemption takes the identity as an argument rather than returning it
      // for comparison here, so the check cannot be forgotten at the call site.
      const grant = redeemJoinTicket(req.body.JoinTicket, callerIdentity);
      if (!grant) {
        return refuseConferenceEntry(res, 'join', 'JoinTicket absent, unknown, expired, or issued to a different caller', {
          requestedConference: ConferenceName || null,
          callSid: req.body.CallSid || null,
          caller: callerIdentity,
        });
      }

      // Defense in depth: a ticket outlives the conference it names if the call
      // ends inside the TTL (removeConference runs on normal call end). Without
      // this check we would hand Twilio the name of a dead conference, and
      // `startConferenceOnEnter: false` would park the joiner in silence
      // forever. Refusing is both more honest and one less way to create a
      // conference nobody asked for.
      if (!getConference(grant.conferenceName)) {
        return refuseConferenceEntry(res, 'join', 'ticket names a conference that has ended', {
          conference: grant.conferenceName,
          callSid: req.body.CallSid || null,
        });
      }

      // Audit the ALLOWED join, not just the refused one. console.log rather
      // than logEvent alone: logEvent is gated on DEBUG=1 (lib/debug-log.js)
      // and is a no-op in a default production boot, and "who listened to whose
      // call, when" is precisely the line that must survive that.
      // Log grant.identity, not callerIdentity: they are equal by construction
      // (redeem refuses otherwise), but the grant's copy states WHICH mint this
      // redemption matched, which is the fact an audit actually wants.
      console.log(`voice: join ALLOWED caller=${grant.identity} conference=${grant.conferenceName} muted=${grant.muted} callSid=${req.body.CallSid}`);

      const dial = twiml.dial();
      dial.conference({
        startConferenceOnEnter: false,
        endConferenceOnExit: false,
        muted: grant.muted,
        beep: false,
      }, grant.conferenceName);

      return res.type('text/xml').send(twiml.toString());
    }

    // Default: "initiate" — caller enters conference.
    // Lead dialing happens in the conference-start status callback (call.js),
    // NOT here. This eliminates the race condition of polling for the conference SID.

    // jsec-r0k6: this branch is reached by OMITTING Action, and it used to be a
    // strictly worse version of the join hole — it takes a client-supplied
    // ConferenceName too, but emits no `muted` attribute (Twilio defaults to an
    // OPEN MIC) and sets endConferenceOnExit="true", so an intruder hanging up
    // would terminate the victim's live customer call. It also stamps their
    // CallSid onto the victim's DB row below, breaking transcription mapping.
    // Guarding only Action==='join' would have closed the front door and left
    // this one open in the same handler.
    //
    // Two facts make this cheap to close without any client or iOS change:
    //   1. Every conference a client can legitimately enter is registered in
    //      lib/conference.js first — all four createConference callsites
    //      (call.js /initiate, sim.js, incoming.js x2) run server-side before
    //      the client is ever told a name.
    //   2. conferenceSid is only ever set AFTER this TwiML is served, by the
    //      conference-start callback (call.js) or the poll fallback, both of
    //      which need a participant to already be in the conference.
    // So a legitimate initiate always names a KNOWN, NOT-YET-STARTED
    // conference, and entering an already-live one is never legitimate — which
    // is exactly the attack.
    //
    // jsec-gsx0 then ADDED a true ownership check below (the r0k6 note that used
    // to sit here said one "needs a verified caller identity — tracked as a
    // follow-up"; that follow-up is the code 20 lines down). Both checks run.
    // They are not redundant: see the note on each.
    const initiating = getConference(ConferenceName);
    if (!initiating) {
      return refuseConferenceEntry(res, 'initiate', 'unknown conference', {
        requestedConference: ConferenceName || null,
        callSid: req.body.CallSid || null,
        caller: callerIdentity,
      });
    }

    // jsec-gsx0: a REAL ownership check, now that the caller identity is
    // established from the authoritative REST Call resource. jsec-r0k6 could
    // only assert the lifecycle invariant above, which left a residual window:
    // between createConference and the conference-start callback (~1s) a
    // conference is known AND not-yet-started, so an attacker who already knew
    // the name could walk in. Ownership closes that window — you must be the rep
    // it was created for, whenever you arrive.
    //
    // Ordered BEFORE the caller_call_sid UPDATE below on purpose: a refused
    // caller must not reach the victim's nucleus_phone_calls row. Stamping their
    // CallSid there breaks transcription mapping for the real rep even though
    // the audio never connected. Pinned by a test that asserts pool.query was
    // never called with SET caller_call_sid.
    //
    // No admin bypass here, deliberately. On this path an admin has no reason
    // to enter a conference started by someone else: /api/call/initiate creates
    // the conference for the identity that will connect, and the PWA and iOS
    // both pass their own identity to /initiate and /token alike. An admin who
    // wants into another rep's call uses the JOIN path, which is where the
    // admin bypass lives (requireConferenceOwner in routes/call.js). Adding a
    // bypass here would reintroduce a way into a live call that skips ticketing
    // altogether.
    // No `owner === ''` clause here, unlike requireConferenceOwner in
    // routes/call.js. There it is load-bearing because req.user.identity can be
    // '' and '' === '' would match. Here callerIdentity is guaranteed a
    // non-empty string (parseClientIdentity returns string|null, never ''), so
    // an ownerless conference already fails the inequality. Copying the idiom
    // would be a dead guard with a false justification — the exact thing
    // deleted from call.js in this same change.
    const owner = typeof initiating.startedBy === 'string' ? initiating.startedBy.toLowerCase() : '';
    if (owner !== callerIdentity) {
      return refuseConferenceEntry(res, 'initiate', 'caller is not the rep this conference was created for', {
        requestedConference: ConferenceName || null,
        callSid: req.body.CallSid || null,
        caller: callerIdentity,
      });
    }

    // NOT merely defense in depth — this is the PRIMARY guard against a
    // principal who can legitimately obtain a token as somebody else.
    // routes/token.js mints an access token for ANY valid identity on the
    // API-key path (its own comment: the shared key "is trusted to act as any
    // identity", token.js:14-21). Such a principal satisfies the ownership check
    // above *as that rep*, and is stopped here and only here. Do not delete this
    // as redundant with the ownership check: it covers a caller the ownership
    // check cannot.
    if (initiating.conferenceSid) {
      return refuseConferenceEntry(res, 'initiate', 'conference is already live — entry via the initiate path is never legitimate', {
        requestedConference: ConferenceName || null,
        callSid: req.body.CallSid || null,
        caller: callerIdentity,
      });
    }

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
    // Subscribe to join/leave too: empirically, Twilio fires participant-join
    // ~800ms before conference-start for PSTN-bridge calls (see call.js:377)
    // and sometimes doesn't fire conference-start at all for REST-created
    // bridge calls (q0z smoke 2026-05-22 verified conference resource exists
    // but no `start` event fires). The status handler's sim branch tolerates
    // either event via idempotency.
    statusCallbackEvent: 'start end join leave',
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

// Same whitelist used by the sim-bridge endpoint — the conference name is
// URL-bound input from the iOS leg's create-call URL so it MUST be
// validated server-side regardless of whatever shape incoming.js writes.
const INBOUND_CONF_RE = /^[A-Za-z0-9_-]+$/;

/**
 * POST /api/voice/inbound-conference-join — TwiML for the iOS leg of a
 * Phase 2 inbound conference (joruva-dialer-mac plan
 * tender-stargazing-valley.md § Phase 2). Twilio fetches this URL AFTER
 * iOS accepts the CallInvite, to determine what the iOS leg does next.
 * The returned TwiML brings the iOS leg into the same conference the
 * caller is already in.
 *
 * IMPORTANT: customParameters (`conference_name`, `call_id`,
 * `caller_phone`) are NOT delivered via this TwiML. They are delivered
 * via the query string on `calls.create`'s `to:` field — Twilio packages
 * those into the PushKit payload's `twi_params` key, which the iOS SDK
 * parses into `TVOCallInvite.customParameters` SYNCHRONOUSLY on receipt
 * (before this URL is even fetched). See `incoming.js` Phase 2 branch
 * and Twilio changelog 2020-09-15 / support article 115011213347.
 *
 * `endConferenceOnExit="true"` on the iOS leg's `<Conference>`: when the
 * rep hangs up via InCallView's End button → CallKit ends → Twilio leg
 * disconnects → conference ends → caller leg drops. This is the
 * asymmetric counterpart to the caller leg's `endConferenceOnExit=false`
 * in incoming.js (the caller leaving must NOT prematurely kill the
 * voicemail-routing path).
 *
 * `answerOnBridge="true"` on `<Dial>`: iOS's `.connected` event fires
 * when the conference bridge is established, not when this TwiML's leg
 * is created. Without it, iOS would see `.connected` immediately and
 * the rep would hear silence until the caller bridge actually formed.
 *
 * Query params (Twilio always POSTs):
 *   conference — required. Conference name; validated against
 *                INBOUND_CONF_RE to reject path traversal / TwiML
 *                injection attempts.
 */
router.post('/inbound-conference-join', makeTwilioWebhook(), (req, res) => {
  const conf = String(req.query.conference || '');

  if (!conf || !INBOUND_CONF_RE.test(conf)) {
    const twiml = new VoiceResponse();
    twiml.say('Invalid conference name.');
    twiml.hangup();
    return res.status(400).type('text/xml').send(twiml.toString());
  }

  const twiml = new VoiceResponse();
  twiml.dial({ answerOnBridge: true })
    .conference({
      endConferenceOnExit: true,
      startConferenceOnEnter: true,
      beep: false,
    }, conf);
  res.type('text/xml').send(twiml.toString());
});

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
