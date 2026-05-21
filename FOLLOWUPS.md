# Follow-ups

Repo-local log of "verify this in a few hours/days when X completes" follow-up tasks. Read at the start of any session that might be affected by a pending follow-up; append at end-of-session when a check is needed but you're not landing it now.

## Why this file exists, not `/schedule`

`~/.claude/CLAUDE.md` "Follow-ups — HARD RULE" forbids offering `/schedule` (or any auto-fire mechanism: `/loop`, `CronCreate`, `ScheduleWakeup`) for one-off "verify in N days" follow-ups. Pattern was tried four times on `joruva-dialer-mac` and never worked: by the time a scheduled run fires, context has drifted, the original judgment for *why* the check matters is lost, and the agent either no-ops or files spurious issues.

This file is the documented escape hatch. A future session reading the entry has the same context the originating session had.

`/schedule` is still acceptable for proactive recurring routines Tom has already endorsed (e.g. weekly triage). Don't pitch it for end-of-session "verify this later" checks.

## Format

Append an entry to **Open Follow-ups** as a new H3:

```
### YYYY-MM-DD — Short title (originating bead/PR/commit)
**Trigger:** What signal tells you the follow-up is now actionable.
**Action:** Concrete step(s) to take.
**Why it matters:** Brief context — why this isn't safe to forget.
**Owner:** Tom (or specific person if delegated).
```

When the follow-up has been resolved, move the entry to **Resolved** with a one-line outcome and date.

Keep entries terse but self-contained — a fresh session should be able to act on the entry without re-reading the originating thread.

---

## Open Follow-ups

### 2026-05-19 — Corrupt team.json recovery procedure (no env-var escape hatch)

**Context:** Before the Linus pass-2 consolidation, inbound routing had a layered fallback: `inbound-routes.json` → `INBOUND_ROUTES` env var → `INBOUND_FORWARD_NUMBER` single-number mode. After the consolidation, `team.json` is the only source — there is no env-var fallback for the rep registry. If `team.json` is corrupted in a force-push or accidentally truncated, all three consumers (incoming.js, escalation.js, sim.js) `process.exit(1)` at boot via `loadRegistryOrExit()`, and Render's auto-restart loop keeps cycling on the bad config until git is reverted.

**Recovery procedure** (when team.json is broken in production):
1. Identify the bad commit via `git log --oneline server/config/team.json`.
2. Revert just the file: `git checkout <good-sha> -- server/config/team.json && git commit -m "revert team.json to <sha>"`.
3. Push to main; Render auto-deploys.
4. Verify boot succeeds via `mcp__joruva-infra__render_get_logs` looking for `incoming: team-registry loaded (N reps, M inbound routes)`.

There is NO Render env-var that can be flipped to restore service without a code push. That's a deliberate trade for the Linus #6 consolidation (one source of truth) — accepting harder recovery in exchange for impossible-to-drift configuration.

If recovery via revert is ever blocked (e.g., the bad commit is itself the revert target), the manual escape is to push a hand-edited `team.json` with the known-good 8 rep entries. Reconstruction sources (the hub runbook does NOT have literal numbers — Linus pass-3 #1 caught the prior wording as misleading):
- **Twilio Phone SIDs** (PN…): `~/stardust/knowledge/runbooks/twilio-voice.md` "Callback Number Registry" table — these are literal.
- **Slack User IDs** (U…): same runbook, "Slack" column — also literal.
- **Mobile numbers** (`+1…`): NOT in the hub runbook (it uses `${TOM_MOBILE}` style placeholders). Pull from `nucleus_phone_users.mobile` rows via `mcp__joruva-infra__db_query` against the prod Postgres, OR from `~/.joruva/secrets.env`'s `PHONE_*` historical env vars if they're still set.
- **iosIdentity / inbound type / DID** (`+1…`): `~/stardust/knowledge/runbooks/twilio-voice.md` "Callback Number Registry" table has the DID (literal) + Tom's flagged as iosIdentity. Cross-reference inbound-routes commit history (`git log --all -- server/config/team.json server/config/inbound-routes.json`) for the canonical per-rep route shape at the time team.json was last sane.

**Owner:** Tom (no action needed unless team.json gets corrupted).

---

### 2026-05-19 — Britt inbound DID provisioning (deferred from drift-cleanup session)

**Trigger:** Britt expands beyond Sales Discovery into closing / inbound coverage, OR she explicitly asks to receive inbound calls on her iOS dialer.

**Action:**
1. Buy a Phoenix-area Twilio DID via the Twilio Numbers API (`twilio api:core:available-phone-numbers:local:list --country-code US --area-code 602` or 480/623).
2. Point its voiceUrl at `https://nucleus-phone.onrender.com/api/voice/incoming`.
3. Edit Britt's entry in `server/config/team.json` — change `"inbound": null` to `{ "did": "+1XXXXXXXXXX", "type": "iosIdentity", "iosIdentity": "britt" }`. Her VoIP token receives push directly — no PSTN forward needed. The registry validator at server/lib/team-registry.js requires `type: 'forward'` rows to have a matching team-phones.json entry, but iosIdentity rows don't.
4. Add a drift sentinel test for her route in `server/lib/__tests__/team-registry.conformance.test.js` mirroring the Ryann + Tom sentinels (replace the "Britt has no inbound entry" sentinel with the new positive assertion).
5. Update `memory/runbooks/twilio-voice.md` + hub mirror.

**Why it matters:** Britt has a VoIP token registered in `nucleus_phone_voip_tokens` (user_id=4, registered 2026-05-17) so the iOS app is live for outbound. Inbound requires the DID + route entry. Easy to forget if not tracked here.

**Owner:** Tom.

---

### 2026-05-14 — Verify CAS pricing for JRS-5E / 15E / 20E / 25E with Billy (compressor-catalog patch)

**Trigger:** Next conversation with Billy at CAS, OR before any customer-facing surface (website, chatbot, quote PDF) consumes the new `JRS-5E $6,995 confirmed` / `JRS-15E $11,995 confirmed` values from `server/lib/compressor-catalog.js`.

**Action:**
1. Ask Billy to confirm or correct four things:
   - JRS-5E MSRP — runbook says $6,995. Catalog now reflects that as `confirmed`.
   - JRS-15E MSRP — runbook says $11,995. Catalog now reflects that as `confirmed`.
   - JRS-20E — does the SKU exist? The runbook says "no JRS-20 SKU exists in CAS catalog, line jumps 15 HP → 25 HP." If true, JRS-20E should be removed from `RS_OPEN_FRAME` at `server/lib/compressor-catalog.js:20`.
   - JRS-25E — is the canonical SKU name actually `JRS-25PRO-460V` per runbook? And what's the real MSRP? Runbook says $17,500 direct/quote. Catalog now has `salesChannel: 'direct'` but `price: null, pricingStatus: 'pending'`.
2. Update `server/lib/compressor-catalog.js` to match verified answers.
3. Update `memory/runbooks/joruva-pricing.md` (or its hub mirror) with the date-stamped verification.

**Why it matters:** This session patched the catalog from a runbook that was 27 days old (flagged as point-in-time, not live state). The `JRS-5E` and `JRS-15E` rows now confidently advertise prices to the sizing engine (`compressor-catalog.js:136` filter requires `pricingStatus === 'confirmed'` + non-null price). If those prices are out of date, the engine quotes wrong numbers. JRS-20E phantom-SKU and JRS-25E SKU-rename are pure bugs masquerading as "pending from Billy."

**Hard-rule reminder:** Per `~/.claude/CLAUDE.md` `feedback_cas_pricing_boundary.md`, >20 HP pricing is phone-sales-only — never publish to website, chatbot, email, or ads. JRS-25E's flip to `salesChannel: 'direct'` enforces this in code; do not regress it.

**Owner:** Tom.

---

## Resolved

*(none yet)*
