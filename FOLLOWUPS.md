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

### 2026-05-19 — Britt inbound DID provisioning (deferred from drift-cleanup session)

**Trigger:** Britt expands beyond Sales Discovery into closing / inbound coverage, OR she explicitly asks to receive inbound calls on her iOS dialer.

**Action:**
1. Buy a Phoenix-area Twilio DID via the Twilio Numbers API (`twilio api:core:available-phone-numbers:local:list --country-code US --area-code 602` or 480/623).
2. Point its voiceUrl at `https://nucleus-phone.onrender.com/api/voice/incoming`.
3. Add an entry to `server/config/inbound-routes.json` with `iosIdentity: "britt"` (her registered VoIP token receives push directly — no PSTN forward needed). Slack field stays `""` until she joins the workspace.
4. Add a drift sentinel test for her route in `server/routes/__tests__/incoming.conformance.test.js` mirroring the Ryann + Tom sentinels.
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
