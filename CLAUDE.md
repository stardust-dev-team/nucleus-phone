# nucleus-phone

Outbound sales dialer PWA for Joruva Industrial. Browser-based soft phone using Twilio Voice SDK with conference-based calling, HubSpot contact integration, pre-call intelligence (Claude rapport generation), Fireflies transcript sync, and team scoreboard with milestone alerts.

## Stack

- **Backend**: Node.js (CommonJS `.js`), Express 4
- **Frontend**: React (`.jsx`), built and served as static files
- **Database**: PostgreSQL via `pg` Pool (shared with UCIL/V3.5)
- **Auth**: Microsoft Entra OAuth2 → JWT session cookie + API key for n8n
- **Hosting**: Render (`srv-d72rkt1r0fns73afe99g`)
- **Phone**: Twilio (+1 602-600-0188)

## Architecture

Entry point: `server/index.js` — Express app with `module.exports = { app }` for testing. `start()` guarded by `require.main === module`.

### Database Tables (owned)

| Table | Purpose |
|-------|---------|
| `nucleus_phone_calls` | Call records: conference, participants, disposition, recording, qualification |
| `ucil_agent_stats` | Materialized daily stats per agent (nightly aggregation) |
| `ucil_sync_state` | Atomic state tracking: credit budgets, sync cursors, milestone claims |

External tables read (not owned): `customer_interactions`, `v35_pb_contacts`, `v35_discovery_queue`, `v35_lead_reservoir`, `v35_webhook_events`, `qa_results`.

### Lib Modules (`server/lib/`)

| Module | Purpose | External Deps |
|--------|---------|---------------|
| `identity-resolver.js` | 4-step identity pipeline (HubSpot → PB → Apollo → Dropcontact) | HubSpot, Apollo, Dropcontact, DB |
| `fireflies-sync.js` | Pull transcripts, 3-layer dedup, Claude analysis, sync | Fireflies GraphQL, Anthropic, DB |
| `conference.js` | In-memory conference state, stale cleanup | None (module-level `setInterval` — no `.unref()`) |
| `claude.js` | Rapport generation with LRU cache + fallback | Anthropic API |
| `hubspot.js` | Contact CRUD with rate-limit retry | HubSpot API |
| `apollo.js` | People matching | Apollo API |
| `dropcontact.js` | Reverse phone→email | Dropcontact API |
| `fireflies.js` | Upload recordings to Fireflies | Fireflies GraphQL |
| `slack.js` | Webhook alerts | Slack incoming webhook |
| `customer-lookup.js` | Aggregate customer_interactions | DB |
| `interaction-sync.js` | Upsert customer_interactions | DB |
| `phone.js` | Phone normalization | None |
| `company-normalizer.js` | Company name normalization + variant generation | None |
| `format.js` | Duration formatting | None |

### Routes (`server/routes/`)

| Mount | Auth | Purpose |
|-------|------|---------|
| `/api/auth` | Self-handled | Microsoft Entra OAuth flow |
| `/api/token` | apiKeyAuth | Twilio capability token |
| `/api/voice` | None (Twilio webhook) | TwiML generation |
| `/api/call` | None (internal) | Conference CRUD: initiate, join, mute, end |
| `/api/call/recording-status` | None (Twilio callback) | Recording URL + Fireflies upload |
| `/api/contacts` | apiKeyAuth | HubSpot contact search/detail |
| `/api/history` | apiKeyAuth | Call history + disposition updates |
| `/api/cockpit` | apiKeyAuth | Pre-call briefing intelligence assembly |
| `/api/fireflies-sync` | apiKeyAuth | Transcript sync (triggered by n8n cron) |
| `/api/scoreboard` | apiKeyAuth | 7-day stats, milestone claims, nightly aggregation |

### Auth Middleware

- `apiKeyAuth`: Checks `x-api-key` header first (for n8n), falls back to session cookie
- `sessionAuth`: JWT from `nucleus_session` cookie, CSRF via `X-Requested-With` header

### Team Config

`server/config/team.json` — hardcoded team members with identity, name, email, role.

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `AZURE_TENANT_ID` | Yes | Entra OAuth |
| `AZURE_CLIENT_ID` | Yes | Entra OAuth |
| `AZURE_CLIENT_SECRET` | Yes | Entra OAuth |
| `AZURE_REDIRECT_URI` | Yes | OAuth callback URL |
| `JWT_SECRET` | Yes | Session token signing |
| `TWILIO_ACCOUNT_SID` | Yes | Twilio auth |
| `TWILIO_AUTH_TOKEN` | Yes | Twilio auth |
| `TWILIO_OUTGOING_APPLICATION_SID` | Yes | TwiML app for outbound calls |
| `HUBSPOT_TOKEN` | Yes | HubSpot private app token |
| `NUCLEUS_PHONE_API_KEY` | Yes | API key for n8n/external callers |
| `APOLLO_API_KEY` | No | Apollo people match (credit-gated, 10/day) |
| `DROPCONTACT_API_KEY` | No | Dropcontact reverse search (credit-gated, 10/day) |
| `FIREFLIES_API_KEY` | No | Fireflies transcript upload + sync |
| `ANTHROPIC_API_KEY` | No | Claude rapport generation + transcript analysis |
| `SLACK_SALES_WEBHOOK_URL` | No | Slack alerts for qualified leads + milestones |

## Development

```bash
npm install
npm run dev          # Start server on :3001
npm test             # Run all tests (Jest)
npm run test:watch   # Watch mode
```

Client is pre-built (`client/dist/`). To rebuild, use whatever bundler produced the existing dist.

## Testing

Jest + supertest. 8 test suites, 74 tests. All mocked — no real DB or API calls.

```
server/lib/__tests__/         # Unit tests for lib modules
server/routes/__tests__/      # Route tests via supertest
server/__tests__/helpers/     # Shared mock factories (mock-pool, mock-fetch)
```

## Conventions

- **CommonJS only** — `require`/`module.exports`, no ESM
- **Error handling**: Graceful degradation with `try/catch` + `console.warn`. Each identity resolution step continues if the previous fails.
- **Credit gating**: `checkCreditBudget()` in identity-resolver.js uses atomic PostgreSQL `INSERT ON CONFLICT ... RETURNING` to prevent TOCTOU races on daily API credit limits.
- **Milestone atomicity**: `claimMilestone()` in scoreboard.js uses `UPDATE ... WHERE NOT @>` for race-safe claim-then-notify.
- **Module-level timers**: `conference.js` has a `setInterval` without `.unref()` (will block process exit). `claude.js` has one with `.unref()`. Tests use `jest.isolateModules()` + `jest.useFakeTimers()` for conference timer tests.
