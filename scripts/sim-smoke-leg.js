#!/usr/bin/env node
/**
 * Reusable PSTN-bridge dialer for smoke-testing sim conferences.
 *
 * Dials a real phone number into a named Twilio conference. No Voice SDK /
 * iOS dev build required — bypasses the CallKit surface so engineers can
 * smoke-test the M3 Phase B2b bridge + Vapi roundtrip headlessly.
 *
 * Usage:
 *   node scripts/sim-smoke-leg.js <simCallId> <rep-phone-E164>
 *   node scripts/sim-smoke-leg.js --conference <name> <rep-phone-E164>
 *   node scripts/sim-smoke-leg.js [--inline-twiml] ...   # legacy inline path
 *
 * Examples:
 *   # Typical: dial rep into sim-103 (server-returned TwiML, default)
 *   node scripts/sim-smoke-leg.js 103 +16025551234
 *
 *   # Dry-run: dial rep into an arbitrary non-sim conference (does NOT trigger
 *   # handleSimConferenceStart, so no Vapi bridge — proves the script's
 *   # outbound-dial + TwiML path without consuming a sim row).
 *   node scripts/sim-smoke-leg.js --conference dryrun-$(date +%s) +16025551234
 *
 * TwiML delivery (nucleus-phone-ufne):
 *   Default — Twilio fetches TwiML from
 *     GET ${APP_URL}/api/voice/sim-bridge-twiml?conf=<name>&sc=<callback>
 *   Inline (legacy) — pass --inline-twiml. Calls.create({ twiml: '...' }) drops
 *   the <Conference statusCallback> attribute in practice, so the bridge fires
 *   no conference-start event. Kept behind a flag for A/B comparison.
 *
 * Required env (loaded from .env or ~/.joruva/secrets.env via lib/load-env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   NUCLEUS_PHONE_NUMBER   - Twilio number to place the outbound from
 *
 * Optional env:
 *   APP_URL                         - base URL hosting /api/voice/sim-bridge-twiml.
 *                                     Defaults to the Render production URL.
 *   NUCLEUS_SIM_STATUS_CALLBACK_URL - override the conference statusCallback URL
 *                                     (passed through to the TwiML endpoint via
 *                                     the `sc` query param, and used inline on
 *                                     --inline-twiml).
 *
 * Design note: the rep phone is a REQUIRED positional arg with no env-var
 * default by intent. Defaulting risks Paul or Britt running this and dialing
 * Tom's cell. See bead nucleus-phone-t6wt for rationale.
 *
 * Exit codes:
 *   0 — Twilio accepted the call (callSid printed as JSON)
 *   1 — usage error (bad args)
 *   2 — required env var missing
 *   3 — Twilio rejected the API call (auth, validation, dialing error)
 */

// Defense against APP_URL leaking from a parent shell that worked in
// stardust-nucleus (q0z smoke incident, 2026-05-21). load-env.js's design
// gives shell-env final precedence, which defeats .env.local's override.
// Clearing it here lets .env.local populate APP_URL with the nucleus-phone URL.
delete process.env.APP_URL;
require('./lib/load-env')();

const twilio = require('twilio');

const DEFAULT_STATUS_CALLBACK = 'https://nucleus-phone.onrender.com/api/call/status';
const DEFAULT_APP_URL = 'https://nucleus-phone.onrender.com';
const CONFERENCE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const E164_RE = /^\+\d{6,15}$/;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/sim-smoke-leg.js [--inline-twiml] <simCallId> <rep-phone-E164>');
  console.error('  node scripts/sim-smoke-leg.js [--inline-twiml] --conference <name> <rep-phone-E164>');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let inlineTwiml = false;
  if (args[0] === '--inline-twiml') {
    inlineTwiml = true;
    args.shift();
  }

  let conferenceName;
  let to;

  if (args[0] === '--conference') {
    if (args.length < 3) usage('--conference requires a name and a phone number');
    conferenceName = args[1];
    to = args[2];
    if (!CONFERENCE_NAME_RE.test(conferenceName)) {
      usage(`--conference name must match ${CONFERENCE_NAME_RE} (got ${JSON.stringify(conferenceName)})`);
    }
  } else {
    if (args.length < 2) usage('simCallId and rep phone are required');
    const simCallId = args[0];
    to = args[1];
    if (!/^\d+$/.test(simCallId)) {
      usage(`simCallId must be numeric (got ${JSON.stringify(simCallId)}). For dry-runs against an arbitrary conference, use --conference.`);
    }
    conferenceName = `sim-${simCallId}`;
  }

  if (!E164_RE.test(to)) {
    usage(`rep phone must be E.164 (e.g. +16025551234), got ${JSON.stringify(to)}`);
  }

  return { conferenceName, to, inlineTwiml };
}

function buildTwiml({ conferenceName, statusCallback }) {
  // The twilio SDK escapes attribute values automatically — prevents XML
  // injection through statusCallback URLs containing & and via the
  // --conference name on the dry-run path. Matches server/routes/voice.js.
  const response = new twilio.twiml.VoiceResponse();
  const dial = response.dial();
  dial.conference({
    endConferenceOnExit: true,
    startConferenceOnEnter: true,
    beep: false,
    statusCallback,
    statusCallbackEvent: 'start end',
    statusCallbackMethod: 'POST',
  }, conferenceName);
  // endConferenceOnExit on the rep leg = rep owns the conference lifecycle:
  // Vapi dropping mid-call (q0z Step 8) does NOT end the conference; only the
  // rep hanging up does. Intended — keeps scoring fires aligned with
  // rep-initiated termination.
  return response.toString();
}

function buildTwimlUrl({ appUrl, conferenceName, statusCallback }) {
  const u = new URL('/api/voice/sim-bridge-twiml', appUrl);
  u.searchParams.set('conf', conferenceName);
  u.searchParams.set('sc', statusCallback);
  return u.toString();
}

async function main() {
  const { conferenceName, to, inlineTwiml } = parseArgs(process.argv);

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.NUCLEUS_PHONE_NUMBER;
  if (!sid || !token || !from) {
    console.error('Missing required env vars. Need: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, NUCLEUS_PHONE_NUMBER');
    process.exit(2);
  }

  const statusCallback = process.env.NUCLEUS_SIM_STATUS_CALLBACK_URL || DEFAULT_STATUS_CALLBACK;
  const appUrl = process.env.APP_URL || DEFAULT_APP_URL;

  const client = twilio(sid, token);

  // Default path (nucleus-phone-ufne): server-returned TwiML via url=. Twilio
  // honors <Conference statusCallback> attributes only when TwiML is fetched
  // from a URL — inline twiml= delivery silently drops conference-level
  // callbacks, so the bridge handler never sees conference-start events.
  // Inline path kept behind --inline-twiml for A/B comparison.
  const createParams = { to, from };
  let deliveryMode;
  if (inlineTwiml) {
    createParams.twiml = buildTwiml({ conferenceName, statusCallback });
    deliveryMode = 'inline';
  } else {
    createParams.url = buildTwimlUrl({ appUrl, conferenceName, statusCallback });
    createParams.method = 'POST';
    deliveryMode = 'url';
  }

  const call = await client.calls.create(createParams);

  console.log(JSON.stringify({
    ok: true,
    callSid: call.sid,
    conferenceName,
    to,
    from,
    status: call.status,
    delivery: deliveryMode,
    twimlUrl: createParams.url || null,
    note: 'call is queued; pickup is not verified by this script',
  }));
}

main().catch((err) => {
  console.error('Failed to place call:', err.message);
  if (err.code) console.error(`Twilio code: ${err.code}`);
  if (err.moreInfo) console.error(`More info: ${err.moreInfo}`);
  process.exit(3);
});
