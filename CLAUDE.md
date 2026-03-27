# Nucleus Phone

Outbound sales dialer PWA for Joruva's 6-person calling team. Twilio Conference-based calling, HubSpot contacts, Fireflies transcription, Slack alerts, Azure Entra SSO, and a Call Cockpit with Claude-powered pre-call rapport intelligence.

**Deployed:** https://nucleus-phone.onrender.com (`srv-d72rkt1r0fns73afe99g`)
**Phone:** (602) 600-0188
**DB:** Shared Postgres with V3.5 and UCIL (same `DATABASE_URL`)

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
| `v35_pb_contacts` | V3.5 | PhantomBuster LinkedIn contacts (read-only) |
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
| `format.js` | Duration formatting | None |
| `test-cockpit-data.js` | Mock cockpit data for dev/demo | None |

### Routes

| Route | Auth | Purpose |
|-------|------|---------|
| `/api/auth` | None (self-handled) | Entra SSO login/callback/logout |
| `/api/token` | API key | Twilio capability token |
| `/api/voice` | None (Twilio webhook) | TwiML for conference join/status |
| `/api/call` | Session cookie | Initiate/end calls |
| `/api/call/recording-status` | None (Twilio webhook) | Recording completion callback |
| `/api/contacts` | Session/API key | HubSpot contact search |
| `/api/history` | Session/API key | Call history, disposition save, Fireflies upload |
| `/api/cockpit/:identifier` | Session/API key | Pre-call rapport intelligence (identity + 7 data sources + Claude) |
| `/api/fireflies-sync` | API key | Fireflies transcript sync (n8n cron, 30min) |
| `/api/scoreboard` | Session/API key | 7-day leaderboard + daily sparklines + milestone aggregation |

### Auth Pattern

`apiKeyAuth` middleware: checks `x-api-key` header first → falls back to session cookie JWT. Twilio webhooks bypass auth. Route order in `index.js` matters: API routes MUST precede `express.static` + catch-all `app.get('*')`.

### Credit-Gating Pattern

Apollo and Dropcontact calls are budget-gated via atomic `INSERT ... ON CONFLICT ... RETURNING` on `ucil_sync_state`. Daily limit: 10 credits each. The `checkCreditBudget()` function in `identity-resolver.js` handles day-reset and increment atomically.

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | Shared Postgres |
| `HUBSPOT_ACCESS_TOKEN` | Yes | HubSpot private app token |
| `TWILIO_ACCOUNT_SID` | Yes | |
| `TWILIO_AUTH_TOKEN` | Yes | |
| `TWILIO_PHONE_NUMBER` | Yes | (602) 600-0188 |
| `NUCLEUS_PHONE_API_KEY` | Yes | For API key auth |
| `JWT_SECRET` | Yes | Session token signing |
| `AZURE_CLIENT_ID` | Yes | Entra SSO |
| `AZURE_CLIENT_SECRET` | Yes | Entra SSO |
| `AZURE_TENANT_ID` | Yes | Entra SSO |
| `FIREFLIES_API_KEY` | Yes | Transcription |
| `ANTHROPIC_API_KEY` | Yes | Claude rapport intel + Fireflies analysis |
| `SLACK_SALES_WEBHOOK_URL` | Optional | Call/milestone alerts |
| `APOLLO_API_KEY` | Optional | Identity Step 3 (skipped if missing) |
| `DROPCONTACT_API_KEY` | Optional | Identity Step 4 (skipped if missing) |

## Development

```bash
# Install
npm install && cd client && npm install && cd ..

# Dev (server only, client pre-built)
npm run dev

# Build client
cd client && npm run build

# Test
npm test
npm run test:watch
```

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
