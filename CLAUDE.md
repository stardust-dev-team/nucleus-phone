# Nucleus Phone

Outbound sales dialer PWA for Joruva's 6-person calling team. Twilio Conference-based calling, HubSpot contacts, Fireflies transcription, Slack alerts, Azure Entra SSO, and a Call Cockpit with Claude-powered pre-call rapport intelligence.

**Deployed:** https://nucleus-phone.onrender.com (`srv-d72rkt1r0fns73afe99g`)
**Phone:** (602) 600-0188
**DB:** Shared Postgres with V3.5 and UCIL (same `DATABASE_URL`)

<!-- Hub imports; fence hand-curated per stardust.config.yaml — read its NOTE before editing. -->
<!-- AUTO-GEN:IMPORTS -->
@~/stardust/knowledge/runbooks/nucleus-phone.md
@~/stardust/knowledge/runbooks/knowledge-management.md
@~/stardust/knowledge/operational-policies.md
@~/stardust/knowledge/writing-style.md
@~/stardust/knowledge/runbooks/twilio-voice.md
@~/stardust/knowledge/runbooks/fireflies-api.md
<!-- AUTO-GEN:IMPORTS-END -->

## Stack

- **Backend:** Node.js (CJS `.js`), Express 4
- **Frontend:** React 18, Vite, plain CSS
- **Auth:** Azure Entra SSO (MSAL) → JWT session cookie + API key header
- **DB:** PostgreSQL via `pg` Pool (no ORM)
- **Telephony:** Twilio (Conference-based, not direct calls)
- **Transcription:** Fireflies.ai (recording upload + sync loop)
- **AI:** Claude API via raw `fetch` (no SDK)
- **Alerting:** Slack webhooks

## Architecture

### Entry Point

`server/index.js` — Express app. Exports `{ app }` for supertest. `start()` guarded by `require.main === module`.

### Database Tables

| Table | Owner | Purpose |
|-------|-------|---------|
| `nucleus_phone_calls` | This service | Call records, disposition, qualification |
| `customer_interactions` | UCIL (creates it) | Cross-channel interaction history. Nucleus writes via `interaction-sync.js` |
| `ucil_agent_stats` | This service | Materialized agent performance (nightly aggregation) |
| `ucil_sync_state` | This service | Sync cursors, credit budgets, milestone dedup keys |
| `v35_pb_contacts` | V3.5 | PhantomBuster LinkedIn contacts. Apollo contacts stored with `source='apollo'` + `apollo_person_id` for webhook matching |
| `v35_discovery_queue` | V3.5 | Pipeline signals (read-only) |
| `v35_lead_reservoir` | V3.5 | ICP scores (read-only) |
| `v35_webhook_events` | V3.5 | Email engagement (read-only) |
| `qa_results` | V3.5 | QA/compliance intel (read-only) |

### Server Lib Modules

| Module | Purpose | External Deps |
|--------|---------|---------------|
| `hubspot.js` | HubSpot CRM (contacts, companies, deals, notes). Rate-limit retry built in | HubSpot API |
| `identity-resolver.js` | 4-step waterfall: HubSpot → PB contacts → Apollo → Dropcontact | All of the above |
| `claude.js` | Rapport intelligence via Claude Sonnet 4.6. LRU cache (200 entries, 15min TTL). 6s timeout + fallback | Anthropic API |
| `interaction-sync.js` | Upsert to `customer_interactions`. DB-only, no HubSpot/Slack | DB |
| `customer-lookup.js` | Prior interaction lookup by phone/email/contactId | DB |
| `fireflies-sync.js` | Pull Fireflies transcripts, 3-layer dedup, Claude analysis, sync | Fireflies + Anthropic APIs |
| `conference.js` | In-memory conference state. Module-level `setInterval` (no `.unref()`) | None |
| `slack.js` | Slack webhook alerts (calls, milestones) | Slack API |
| `phone.js` | Phone normalization (E.164) | None |
| `company-normalizer.js` | Company name normalization + variant generation | None |
| `apollo.js` | Apollo People Match (credit-gated, 10/day) | Apollo API |
| `dropcontact.js` | Dropcontact reverse search (credit-gated, 10/day) | Dropcontact API |
| `twilio.js` | Twilio client singleton | Twilio SDK |

(Also: `format.js` duration formatting, `test-cockpit-data.js` mock cockpit data.)

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `/api/auth` | None (self-handled) | Entra SSO login/callback/logout |
| `/api/token` | API key | Twilio capability token |
| `/api/voice` | None (Twilio webhook) | TwiML for conference join/status |
| `/api/call` | Session cookie | Initiate/end calls |
| `/api/call/recording-status` | None (Twilio webhook) | Recording completion callback |
| `/api/contacts` | Session/API key | HubSpot contact search |
| `/api/history` GET (list + `/:id` + `/:id/timeline`) | Session only | Activity feed with FTS search (`q`), date range (`from`/`to`), `disposition`, `qualification`, `hasSummary`, enriched via LATERAL JOIN on customer_interactions. Non-admin callers forced to own calls. Returns sensitive AI data — NOT safe for API key access. |
| `/api/history/:id/disposition` POST | Session/API key | Disposition save, Slack alert, HubSpot sync, interaction sync, optional follow-up email (session only). Non-admin ownership check when session-authed. |
| `/api/cockpit/:identifier` | Session/API key | Pre-call rapport intelligence (identity + 7 data sources + Claude) |
| `/api/fireflies-sync` | API key | Fireflies transcript sync (n8n cron, 30min) |
| `/api/scoreboard` | Session/API key | 7-day leaderboard + daily sparklines + milestone aggregation |

### Auth Pattern

`apiKeyAuth` middleware: checks `x-api-key` header first → falls back to session cookie JWT. Twilio webhooks bypass auth. Route order in `index.js` matters: API routes MUST precede `express.static` + catch-all `app.get('*')`.

### Credit-Gating Pattern

Apollo/Dropcontact calls are budget-gated (10/day each) via atomic `INSERT ... ON CONFLICT ... RETURNING` on `ucil_sync_state` — `checkCreditBudget()` in `identity-resolver.js` handles day-reset + increment atomically.

## Environment Variables

Required: `DATABASE_URL`, `HUBSPOT_ACCESS_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` ((602) 600-0188), `NUCLEUS_PHONE_API_KEY`, `JWT_SECRET`, `AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` (Entra SSO), `FIREFLIES_API_KEY`, `ANTHROPIC_API_KEY`.
Optional: `SLACK_SALES_WEBHOOK_URL` (alerts), `APOLLO_API_KEY` + `DROPCONTACT_API_KEY` (identity steps 3/4 — skipped if missing), `MULTICHANNEL_API_URL` + `MC_API_KEY` (signals proxy).

## Development

`npm install && cd client && npm install` · `npm run dev` (server only, client pre-built) · `cd client && npm run build` · `npm test` / `npm run test:watch`

## Testing

Jest + supertest. Config: `jest.config.js`. Tests in `server/lib/__tests__/` and `server/routes/__tests__/`.

**Test helpers:**
- `server/__tests__/helpers/mock-pool.js` — Mock pg Pool factory
- `server/__tests__/helpers/mock-fetch.js` — Mock global.fetch with response factories

**Gotchas:**
- `conference.js` has a module-level `setInterval` without `.unref()` — Jest uses `forceExit: true`
- `claude.js` uses `jest.isolateModules()` per test to reset LRU cache
- Scoreboard milestones are fire-and-forget — flush with `await new Promise(r => setImmediate(r))` before asserting

## Conventions

- **CJS everywhere** — `require`/`module.exports`, no ESM
- **Error handling:** Inline `try/catch + res.status(500).json({error})` in routes. Do NOT use `next(err)`.
- **DB queries:** Direct `pool.query()` with parameterized SQL. No ORM.
- **Auth per-handler:** Routes use `apiKeyAuth` middleware inline, not at router level
- **Credit-gating:** Always check `checkCreditBudget(service)` before paid API calls
- **Interaction sync:** Fire-and-forget `.catch(err => console.error(...))` pattern

## Signal Engine
- `client/src/components/cockpit/SignalBadges.jsx` — tier badge + cert/contract/multi-source badges
- `client/src/pages/Pipeline.jsx` — team work queue (distinct from dashboard's Pipeline.tsx)
- `server/routes/signals.js` — proxies to multichannel API. CRITICAL: /pipeline route MUST be before /:domain (Express route ordering)
- Env: MULTICHANNEL_API_URL, MC_API_KEY

## Follow-ups — HARD RULE

Never offer `/schedule` (or `/loop`, `CronCreate`, `ScheduleWakeup`) for one-off end-of-session checks — the global `~/.claude/CLAUDE.md` rule. Approved method: append to `FOLLOWUPS.md` at the repo root (format at its top); read it at session start, append at end-of-session when a later verification is needed. `/schedule` stays acceptable only for recurring routines Tom already endorsed.
