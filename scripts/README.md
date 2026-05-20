# nucleus-phone scripts

Operational + smoke-test scripts for the nucleus-phone dialer.

## Sim bridge smoke-test (M3 Phase B2b)

Two scripts let you smoke-test the iOS sim bridge (`/api/sim/call/ios` + B2b
conference-start handler) end-to-end without an iOS dev build or Voice SDK
client. They use Twilio's REST API + inline TwiML to inject a real PSTN leg
into a `sim-{id}` conference, so the bridge fires `handleSimConferenceStart`
and Vapi joins.

Trade-off: bypasses the PushKit/CallKit/Live Assist iOS surface. The bridge +
Vapi roundtrip + scoring path runs, but the iOS UI is not exercised. Filed as
`nucleus-phone-t6wt`.

### `sim-smoke-leg.js` — PSTN bridge dialer

Dials a real phone into a named Twilio conference via inline TwiML. Caller
owns the conference lifecycle (`endConferenceOnExit="true"` on the rep leg).

```bash
# Dial rep into sim-103 (typical use, after minting a sim row)
node scripts/sim-smoke-leg.js 103 +16025551234

# Dry-run: dial into an arbitrary non-sim conference. FriendlyName doesn't
# start with `sim-`, so handleSimConferenceStart does NOT fire — proves the
# script's outbound + TwiML path without consuming a sim row.
node scripts/sim-smoke-leg.js --conference dryrun-$(date +%s) +16025551234
```

Required env (loaded from `.env` or `~/.joruva/secrets.env`):

| Var | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `NUCLEUS_PHONE_NUMBER` | Twilio number to place outbound from |

The rep phone is a required positional arg with no env-var default by intent
(avoid Paul/Britt accidentally dialing Tom's cell).

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Twilio accepted the call (callSid printed as JSON) |
| 1 | Usage error (bad args) |
| 2 | Required env var missing |
| 3 | Twilio rejected the API call |

### `sim-smoke.js` — bundled smoke wrapper

One-shot wrapper that mints the sim row, dials the rep leg, then tails
`debug_events` + polls `sim_call_scores` bridge fields to stdout for live
verification of q0z Steps 3, 4, 6.

```bash
node scripts/sim-smoke.js mike-garza easy +16025551234
node scripts/sim-smoke.js mike-garza easy +16025551234 --timeout 120
```

Additional env required (on top of the leg-dialer env above):

| Var | Purpose |
| --- | --- |
| `NUCLEUS_PHONE_API_KEY` | `x-api-key` for the `/api/sim/call/ios` POST |
| `DATABASE_URL` | Postgres for `debug_events` tail + `sim_call_scores` poll |
| `NUCLEUS_PHONE_BASE_URL` | Optional — defaults to `https://nucleus-phone.onrender.com` |

Notes:

- `debug_events` only records when the server runs with `DEBUG=1` (see
  `server/lib/debug-log.js`). Bridge events (`handleSimConferenceStart`) use
  `console.log` and won't appear in `debug_events` — verify those via Render
  service logs.
- The wrapper exits as soon as `sim_call_scores.status` reaches a terminal
  state (`completed` / `score-failed` / `cancelled`) or `--timeout` elapses.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Tail reached terminal status or timeout cleanly elapsed |
| 1 | Usage error, env-var missing, or operational failure |
| 130 | Interrupted (SIGINT/SIGTERM) |

### q0z 9-step smoke checklist

`joruva-dialer-mac-q0z` documents the full M3 Phase B2b smoke. Quick map of
which steps this wrapper covers automatically vs which require manual checks:

| Step | What | Coverage |
| --- | --- | --- |
| 1 | POST `/api/sim/call/ios` | Automatic |
| 2 | Connect rep leg | Automatic (PSTN bridge replaces Voice SDK) |
| 3 | DB bridge fields populated within 5s | Tail prints state changes |
| 4 | `debug_events` subscribe / `sim-{id}` | Tail surfaces it (requires `DEBUG=1` server-side) |
| 5 | Rep hears Vapi voice within 3s | Manual — rep on the call |
| 6 | `equipment_detected` / `response_suggestion` broadcasts | Tail surfaces what hits `debug_events`; full check needs WS client |
| 7 | Rep ends call → conference ends, Vapi drops, scoring fires | Tail prints `status → completed` |
| 8 | Kill Vapi from dashboard mid-call | Manual + verify via Vapi dashboard + tail |
| 9 | Twilio webhook retry idempotency | Manual `curl` re-POST of conference-start callback |
