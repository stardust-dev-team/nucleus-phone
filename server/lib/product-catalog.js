/**
 * product-catalog.js — Compact product catalog string for LLM prompts.
 *
 * Single source of truth. Imported by claude.js (rapport briefings),
 * conversation-pipeline.js (real-time analyst), and
 * scripts/test-conversation-latency.js (latency gate).
 *
 * Hand-curated snapshot of confirmed-pricing SKUs — deliberately NOT
 * derived from compressor-catalog.js or sizing-engine.js, to keep the
 * prompt surface decoupled from the runtime sizing logic. If prices
 * change in those files, update this string.
 *
 * Last reviewed against compressor-catalog.js: 2026-04-04.
 */

const PRODUCT_CATALOG = `Joruva Industrial products (confirmed pricing):
Compressors: JRS-7.5E 7.5HP 28CFM $7,495 | JRS-10E 10HP 38CFM $9,495 | JRS-30 30HP 125CFM $19,500 (direct)
Dryers (refrigerated): JRD-30 $2,195 | JRD-40 $2,495 | JRD-60 $2,895 | JRD-80 $3,195 | JRD-100 $3,595
Dryers (desiccant, -60°F, molecular sieve, wall-mount): JDD-40 40CFM $7,495 | JDD-80 80CFM $11,895
Filters: JPF-70 particulate 1µm $399 | JPF-130 $499 | JCF-70 coalescing 0.01µm $349 | JCF-130 $449
OWS (oil-water separator): OWS75 $234 | OWS150 $1,092
Larger systems (30HP+): direct sale, custom quote required.
For AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.`;

module.exports = { PRODUCT_CATALOG };
