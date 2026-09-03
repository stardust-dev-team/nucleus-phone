# KSI Demo Persona ("ksi-dave") — Provision & Deploy Runbook

Branch: `feat/ksi-demo-persona` (do NOT merge to main / deploy without sign-off).

This adds a second practice-call persona, **ksi-dave** (Dave Kowalski, owner of
Midwest Air Power — an independent compressed-air distributor), for a KSI
Technologies sales demo. The existing **mike-garza** persona is untouched and
remains the default.

## How the persona switch works

A single server env var, **`SIM_ACTIVE_PERSONA`**, chooses which persona the
practice path serves end-to-end:

- **unset (or empty)** → `mike-garza` (identical to today's behavior)
- **`ksi-dave`** → the KSI persona (prompt, Vapi assistant, greeting, cockpit)

The active persona drives all four pieces of the PWA practice path
(`POST /api/sim/call` in `server/routes/sim.js`):

| Piece | Mechanism |
|-------|-----------|
| System prompt | `getPromptVersion()` reads `config/sim-personas/<persona>-<difficulty>.txt` |
| Vapi assistant | `resolveAssistantId({ personaId, difficulty })` → `VAPI_SIM_KSI_<DIFF>_ID`, falls back to legacy `VAPI_SIM_<DIFF>_ID` |
| Greeting | `pickGreeting(difficulty, personaId)` — persona-keyed pools in `server/lib/sim-greetings.js` |
| Cockpit briefing | client requests `GET /api/cockpit/sim-active` → `cockpit.js` resolves `sim-active` → active persona's `server/config/sim-contacts/<persona>*.json` |

The client practice route (`client/src/App.jsx`) now requests the
persona-neutral id `sim-active` instead of the hardcoded `sim-mike-garza`, so it
follows `SIM_ACTIVE_PERSONA` with no client-side persona knowledge. Explicit ids
`sim-mike-garza` and `sim-ksi-dave` still work directly (back-compat / testing).

## Step 1 — Provision the 3 KSI Vapi assistants (NOT yet done)

The setup script is now persona-parametrized. From the repo root, with
`VAPI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` in `.env` (and the
existing `SIM_PHONE_NUMBER` + `VAPI_PRACTICE_PHONE_ID` so it REUSES the shared
practice number rather than buying a new one):

```bash
node scripts/setup-vapi-assistants.js ksi-dave
```

This creates three Vapi assistants named "Dave Kowalski (easy|medium|hard)" from
`config/sim-personas/ksi-dave-{easy,medium,hard}.txt`, reusing the same
ElevenLabs voice, webhook URL, and `VAPI_WEBHOOK_SECRET` as mike-garza. It prints
the env var lines to add (see Step 2). It does NOT delete or touch the mike-garza
assistants.

Manual alternative (if you'd rather not run the script): in the Vapi dashboard,
duplicate each mike-garza assistant, replace the system prompt with the matching
`ksi-dave-<difficulty>.txt` contents, set the name, keep the same voice + server
webhook (url `…/api/sim/webhook`, same secret), and note the three new assistant
IDs.

## Step 2 — Set Render env vars (nucleus-phone service)

Add the three assistant IDs the script printed, plus the persona switch:

```
VAPI_SIM_KSI_EASY_ID=<easy assistant id>
VAPI_SIM_KSI_MEDIUM_ID=<medium assistant id>
VAPI_SIM_KSI_HARD_ID=<hard assistant id>
SIM_ACTIVE_PERSONA=ksi-dave
```

None of these consume paid API credits by existing (they only gate which Vapi
assistant a practice call dials). Setting `SIM_ACTIVE_PERSONA` is what flips the
demo live.

## Step 3 — Deploy

Deploy the branch to the nucleus-phone service (client is rebuilt by
`npm run build`, which bakes the `sim-active` change into the PWA). On boot,
`validatePersonaConfig()` logs a warning for any unresolved persona/difficulty
slot — confirm the three KSI slots resolve (no warning for `ksi-dave/*`).

Smoke test: open `/practice`, start an easy call. The cockpit should show Dave
Kowalski / Midwest Air Power, and the assistant should answer "Midwest Air
Power, this is Dave."

## Flip back to Mike Garza after the demo

Either:

- **Delete** `SIM_ACTIVE_PERSONA` from Render (reverts to mike-garza), or
- Set `SIM_ACTIVE_PERSONA=mike-garza` explicitly.

Redeploy/restart. The KSI assistant IDs can stay set — they're inert unless
`SIM_ACTIVE_PERSONA=ksi-dave`. No need to delete the Vapi assistants unless you
want to clean them up.

## Files in this change

New:
- `config/sim-personas/ksi-dave-{easy,medium,hard}.txt` — Vapi voice-AI system prompts
- `server/config/sim-contacts/ksi-dave{,-easy,-medium,-hard}.json` — cockpit briefings
- `docs/ksi-demo-persona-runbook.md` — this file

Changed (all back-compatible; mike-garza behavior preserved when `SIM_ACTIVE_PERSONA` is unset):
- `config/sim-personas/personas.json` — registered `ksi-dave`
- `server/lib/personas.js` — `activePersonaId()`, `getPersona()`
- `server/lib/sim-greetings.js` — persona-keyed greeting pools, `pickGreeting(difficulty, personaId)`
- `server/routes/sim.js` — POST /call keys prompt/assistant/greeting/conference off the active persona
- `server/routes/cockpit.js` — persona-keyed sim-contact registry; `sim-active` + `sim-<personaId>` resolution
- `server/routes/call.js` — iOS bridge greeting passes personaId
- `client/src/App.jsx` — practice route requests `sim-active`
- `scripts/setup-vapi-assistants.js` — persona-parametrized (default mike-garza)
- Tests: `server/lib/__tests__/personas.test.js`, `server/routes/__tests__/sim-personas.test.js`

## Scope constraint (KSI legal)

KSI treatment here is **dryers and filtration only**. Oil-water separators /
condensate handling are deliberately kept out of every KSI prompt and cockpit
file — do not add them.
