/**
 * objection-pairs.js — Common objection/rebuttal pairs for LLM prompts.
 *
 * Single source of truth. Imported by conversation-pipeline.js (real-time
 * analyst) and scripts/test-conversation-latency.js (latency gate).
 *
 * Provenance: hand-curated from sim-scorer.js patterns and accumulated sales
 * knowledge. NOT derived from a runtime rebuttal store — the prompt surface
 * stays decoupled so phrasing tweaks here don't ripple into call-time logic.
 * If real-call objection patterns shift materially, refresh this string.
 */

const OBJECTION_PAIRS = `Common objections and rebuttals:
- "Too expensive" / "We're cheaper than the downtime you're paying for now. JRS-10E pays for itself in 18 months vs ongoing recip maintenance."
- "We already have a vendor" / "Totally get it. Most of our customers had a vendor too. We're not asking you to switch tomorrow — just worth a comparison on the next replacement cycle."
- "Never heard of Joruva" / "Fair point. We're newer to the market, which means better pricing and actual phone support — not a 1-800 number."
- "Just looking" / "No pressure at all. Let me send you specs so when the time comes, you've got everything in front of you."
- "Need to talk to my partner/boss" / "Of course. Want me to put together a one-pager you can share? Makes the conversation easier."`;

module.exports = { OBJECTION_PAIRS };
