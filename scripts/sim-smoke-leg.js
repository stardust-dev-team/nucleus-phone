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
 *
 * Examples:
 *   # Typical: dial rep into sim-103
 *   node scripts/sim-smoke-leg.js 103 +16025551234
 *
 *   # Dry-run: dial rep into an arbitrary non-sim conference (does NOT trigger
 *   # handleSimConferenceStart, so no Vapi bridge — proves the script's
 *   # outbound-dial + TwiML path without consuming a sim row).
 *   node scripts/sim-smoke-leg.js --conference dryrun-$(date +%s) +16025551234
 *
 * Required env (loaded from .env or ~/.joruva/secrets.env via lib/load-env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   NUCLEUS_PHONE_NUMBER   - Twilio number to place the outbound from
 *
 * Optional env:
 *   NUCLEUS_SIM_STATUS_CALLBACK_URL - override the default conference
 *                                     statusCallback URL.
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

require('./lib/load-env')();

const twilio = require('twilio');

const DEFAULT_STATUS_CALLBACK = 'https://nucleus-phone.onrender.com/api/call/status';
const CONFERENCE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const E164_RE = /^\+\d{6,15}$/;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage:');
  console.error('  node scripts/sim-smoke-leg.js <simCallId> <rep-phone-E164>');
  console.error('  node scripts/sim-smoke-leg.js --conference <name> <rep-phone-E164>');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
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

  return { conferenceName, to };
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

async function main() {
  const { conferenceName, to } = parseArgs(process.argv);

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.NUCLEUS_PHONE_NUMBER;
  if (!sid || !token || !from) {
    console.error('Missing required env vars. Need: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, NUCLEUS_PHONE_NUMBER');
    process.exit(2);
  }

  const statusCallback = process.env.NUCLEUS_SIM_STATUS_CALLBACK_URL || DEFAULT_STATUS_CALLBACK;
  const twiml = buildTwiml({ conferenceName, statusCallback });

  const client = twilio(sid, token);
  const call = await client.calls.create({ to, from, twiml });

  console.log(JSON.stringify({
    ok: true,
    callSid: call.sid,
    conferenceName,
    to,
    from,
    status: call.status,
    note: 'call is queued; pickup is not verified by this script',
  }));
}

main().catch((err) => {
  console.error('Failed to place call:', err.message);
  if (err.code) console.error(`Twilio code: ${err.code}`);
  if (err.moreInfo) console.error(`More info: ${err.moreInfo}`);
  process.exit(3);
});
