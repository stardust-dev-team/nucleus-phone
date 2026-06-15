/**
 * compressor-catalog.js — Full CAS product catalog with Joruva SKUs.
 *
 * Verified against official CAS PDF catalogs (compressed-air-systems.com/knowledge-base/catalogs)
 * and cross-referenced with industrialgold.com and compressorworld.com. April 2026.
 *
 * IMPORTANT: Array MUST remain sorted by CFM ascending. selectFilter and
 * recommendSystem rely on this ordering.
 */

// --- RS Open Frame (Electric) — 5 to 100 HP ---
// CFM values @ 150 PSI from official CAS spec sheets.
// 5-20HP: existing Joruva ecommerce SKUs (JRS-{HP}E pattern).
// 25HP+: direct sale only, pricing TBD from CAS.
const RS_OPEN_FRAME = [
  { model: 'JRS-5E',    hp: 5,    cfm: 18,  psi: 150, price: 6995,  voltage: '230V/1ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRS-7.5E',  hp: 7.5,  cfm: 28,  psi: 150, price: 7495,  voltage: '230V/1ph or 3ph',   productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRS-10E',   hp: 10,   cfm: 38,  psi: 150, price: 9495,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRS-15E',   hp: 15,   cfm: 54,  psi: 150, price: 11995, voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  // JRS-20E is <=20 HP so web-eligible, but CAS hasn't provided an MSRP yet, so no
  // joruva.com listing exists — sold 'direct' (phone) until then (nucleus-phone-oqv).
  // When pricing confirms, flip back: price + pricingStatus:'confirmed' + salesChannel:'ecommerce'.
  { model: 'JRS-20E',   hp: 20,   cfm: 78,  psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'pending' },
  { model: 'JRS-25E',   hp: 25,   cfm: 102, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'pending' },
  { model: 'JRS-30',    hp: 30,   cfm: 125, psi: 150, price: 19500, voltage: '230/460V/3ph',      productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'confirmed' },
  { model: 'JRS-40',    hp: 40,   cfm: 155, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-50',    hp: 50,   cfm: 185, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-60',    hp: 60,   cfm: 210, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-75',    hp: 75,   cfm: 285, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-100',   hp: 100,  cfm: 405, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
];

// --- Permanent Magnet VSD (Enclosed, Variable Speed) — 10 to 200 HP ---
// CFM @ 150 PSI from official CAS PermMagBrochure.pdf.
// IE4 Super Premium motors, zero-loss direct-drive, liquid-cooled.
// All direct sale — reps should route to Alex for sizing consultation, but
// starting MSRPs below are confirmed and quotable as an anchor ("starts around $X").
// MSRPs confirmed 2026-04-10 from CAS net pricing. Marked 'confirmed' when Billy
// has provided a net cost we've priced against; 'quote_required' where no cost is available.
const PM_VSD = [
  { model: 'JVSD-10',   hp: 10,   cfm: 34,  psi: 150, price: null,    voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-15',   hp: 15,   cfm: 53,  psi: 150, price: null,    voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-20',   hp: 20,   cfm: 71,  psi: 150, price: null,    voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-30',   hp: 30,   cfm: 109, psi: 150, price: null,    voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-50',   hp: 50,   cfm: 187, psi: 150, price: 36995,   voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
  { model: 'JVSD-60',   hp: 60,   cfm: 230, psi: 150, price: null,    voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-75',   hp: 75,   cfm: 320, psi: 150, price: 62995,   voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
  { model: 'JVSD-100',  hp: 100,  cfm: 406, psi: 150, price: 74995,   voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
  { model: 'JVSD-125',  hp: 125,  cfm: 577, psi: 150, price: 84995,   voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
  { model: 'JVSD-150',  hp: 150,  cfm: 741, psi: 150, price: 109995,  voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
  { model: 'JVSD-200',  hp: 200,  cfm: 960, psi: 150, price: 139995,  voltage: '460V/3ph',         productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'confirmed' },
];

// --- Large Frame Enclosed — 125 to 476 HP ---
// Two-stage CFM values from compressed-air-systems.com.
// Pressure rating unconfirmed on CAS site (likely ~125 PSI, using as-listed).
// All direct sale only.
const LARGE_FRAME = [
  { model: 'JLF-125',  hp: 125,  cfm: 518,  psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-150',  hp: 150,  cfm: 653,  psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-180',  hp: 180,  cfm: 749,  psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-220',  hp: 220,  cfm: 875,  psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-270',  hp: 270,  cfm: 1121, psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-335',  hp: 335,  cfm: 1369, psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-425',  hp: 425,  cfm: 1670, psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JLF-476',  hp: 476,  cfm: 1895, psi: 125, price: null, voltage: '460V/3ph', productLine: 'large_frame', salesChannel: 'direct', pricingStatus: 'quote_required' },
];

// Product line priority for sort tiebreaking. Lower = preferred.
// RS Open Frame is the standard recommendation; PM/VSD is a premium upsell.
const LINE_PRIORITY = { rs_open: 0, large_frame: 1, pm_vsd: 2 };

// --- Persona Defaults (Phase D relationship_value LTV math) ---
//
// Maps a prospect's title (case-insensitive substring match) to "what
// would this person typically buy" — used by the JS post-processor in
// /Users/Shared/nucleus-phone/server/routes/cockpit.js to derive the
// `relationship_value` field surfaced in the iOS LiveCockpit
// RelationshipValueCard.
//
// HP class anchors against the confirmed-price tiers in this catalog
// and the joruva-pricing runbook (memory/runbooks/joruva-pricing.md):
//   ≤15 HP: ecommerce — JRS-5E/7.5E/10E/15E
//   25–30 HP: direct phone-sales — JRS-25PRO ($17,500) / JRS-30PRO ($19,500)
//   ≥50 HP: PM VSD direct — JVSD-50/75/100/125/150/200
//
// Most Joruva deals are one-shot capex purchases (per-project, not
// per-year), so `unitsPerYear: 1` is the default. Multi-site personas
// (Supply Chain, Maintenance) get 2.
//
// Parts/service ratios reflect CAS reseller economics for rotary screw:
//   partsRatio  ~0.35  → ~9%/yr equipment cost in parts/filters/dryer service (yrs 2-5)
//   serviceRatio ~0.45 → ~9%/yr equipment cost in overhauls/replacement (yrs 6-10)
//
// **DRAFT — TUNE FROM PIPELINE DATA**: HP class is grounded in the
// runbook channel split, but the unitsPerYear and ratio values are
// pending real close-rate data. Conservative first pass.
//
// **Note on HP gradient under current catalog state**: defaultHp values
// of 25 and 30 both resolve to JRS-30 ($19,500) via pricedModelAtOrAbove
// because JRS-25E is null-priced. So the practical LTV gradient today
// is 15-HP-class vs 30-HP-class. Finer grain unlocks automatically when
// JRS-20E / JRS-25E pricing confirms (set `pricingStatus: 'confirmed'`
// + `price: <USD>` and the persona table picks them up with no code
// changes).
const PERSONA_DEFAULTS = {
  // VP Operations — capex authority for the line-running compressor.
  // Aerospace/mid-mfr typical: 25-30 HP class.
  'operations':  { defaultHp: 30, unitsPerYear: 1, partsRatio: 0.35, serviceRatio: 0.45 },
  // Plant Manager — slightly smaller HP than VP Ops; same buying motion.
  'plant':       { defaultHp: 25, unitsPerYear: 1, partsRatio: 0.35, serviceRatio: 0.45 },
  // Maintenance — replacement cycle on existing kit, smaller HP, 2+ sites.
  'maintenance': { defaultHp: 15, unitsPerYear: 2, partsRatio: 0.40, serviceRatio: 0.45 },
  // Engineering — specs the system but doesn't sign; match Operations sizing.
  'engineering': { defaultHp: 30, unitsPerYear: 1, partsRatio: 0.35, serviceRatio: 0.45 },
  // Quality / QA — drives desiccant + coalescing for AS9100 / cleanroom,
  // not the main compressor. Lower HP, lower deal value.
  'quality':     { defaultHp: 15, unitsPerYear: 1, partsRatio: 0.30, serviceRatio: 0.40 },
  // Purchasing / procurement — TCO-focused, one big purchase per cycle.
  'purchasing':  { defaultHp: 30, unitsPerYear: 1, partsRatio: 0.35, serviceRatio: 0.45 },
  'procurement': { defaultHp: 30, unitsPerYear: 1, partsRatio: 0.35, serviceRatio: 0.45 },
  // Facilities — building infrastructure decisions, smaller HP, slower cycle.
  'facilities':  { defaultHp: 15, unitsPerYear: 1, partsRatio: 0.30, serviceRatio: 0.40 },
  // Supply chain — multi-site, mid-HP, faster turn. Multi-word key so
  // longest-match disambiguates "Supply Chain Operations Manager"
  // (12-char `supply chain` > 10-char `operations`). A vague "VP
  // Supply" title falls through to GENERIC, which is the safer call.
  'supply chain': { defaultHp: 25, unitsPerYear: 2, partsRatio: 0.35, serviceRatio: 0.45 },
};

const GENERIC_PERSONA_DEFAULT = {
  defaultHp: 15,
  unitsPerYear: 1,
  partsRatio: 0.30,
  serviceRatio: 0.40,
};

/**
 * Find the persona defaults for a contact title via case-insensitive
 * **longest-match** against PERSONA_DEFAULTS keys. Critical for titles
 * with multiple persona words ("Supply Chain Operations Manager"
 * matches `operations` first under first-match — but `supply` is
 * arguably the more specific intent. Longest-key wins disambiguates
 * deterministically: longer keys = more specific persona).
 *
 * If multiple keys tie on length, falls back to the first declared
 * (PERSONA_DEFAULTS insertion order = soft priority).
 *
 * Returns GENERIC_PERSONA_DEFAULT when no key matches.
 */
function personaDefaultsFor(title) {
  if (!title) return GENERIC_PERSONA_DEFAULT;
  const lower = String(title).toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const [key, defaults] of Object.entries(PERSONA_DEFAULTS)) {
    if (lower.includes(key) && key.length > bestLen) {
      best = defaults;
      bestLen = key.length;
    }
  }
  return best || GENERIC_PERSONA_DEFAULT;
}

/**
 * Pick the first catalog entry whose HP equals or exceeds `targetHp`
 * AND has a confirmed price. Returns null if no priced model matches —
 * the relationship_value derivation then degrades to qty-only (no
 * dollars).
 */
function pricedModelAtOrAbove(targetHp) {
  return COMPRESSOR_CATALOG.find(
    (m) => m.hp >= targetHp && m.price != null && m.pricingStatus === 'confirmed',
  ) || null;
}

// Merge all lines into a single catalog, sorted by CFM ascending.
// When CFM values are close, RS Open Frame sorts first so the sizing engine
// (which picks the first match via array.find) recommends the standard line.
const COMPRESSOR_CATALOG = [
  ...RS_OPEN_FRAME,
  ...PM_VSD,
  ...LARGE_FRAME,
].sort((a, b) => {
  if (a.cfm !== b.cfm) return a.cfm - b.cfm;
  const pa = LINE_PRIORITY[a.productLine] ?? 9;
  const pb = LINE_PRIORITY[b.productLine] ?? 9;
  if (pa !== pb) return pa - pb;
  return a.hp - b.hp;
});

// Module-init invariant: `pricedModelAtOrAbove` walks COMPRESSOR_CATALOG
// in order and returns the FIRST entry matching `hp >= targetHp && priced
// && confirmed`. That's only correct if the *confirmed-priced* subset is
// HP-monotonic in catalog order. (The full catalog isn't — JLF-220 lands
// before JVSD-200 because cfm-sort puts 875 before 960 — but JLF-220
// isn't confirmed-priced, so it's never returned.) If a future edit
// adds a low-HP confirmed-priced entry late in the array (or reorders
// confirmed-priced entries), pricedModelAtOrAbove silently anchors LTV
// math on the wrong price. Fail load-time, not at runtime under a rep.
const _pricedConfirmed = COMPRESSOR_CATALOG.filter(
  (m) => m.price != null && m.pricingStatus === 'confirmed'
);
for (let i = 1; i < _pricedConfirmed.length; i++) {
  if (_pricedConfirmed[i].hp < _pricedConfirmed[i - 1].hp) {
    throw new Error(
      `compressor-catalog: confirmed-priced HP-monotonic invariant violated. ` +
      `${_pricedConfirmed[i].model} (hp=${_pricedConfirmed[i].hp}) appears after ` +
      `${_pricedConfirmed[i - 1].model} (hp=${_pricedConfirmed[i - 1].hp}) in catalog order. ` +
      `pricedModelAtOrAbove depends on this ordering.`
    );
  }
}

// Module-init invariant: >20 HP is phone-sales-only per
// feedback_cas_pricing_boundary.md (HARD RULE). Any catalog entry with
// hp > 20 && salesChannel anything other than 'direct' is a
// published-pricing leak waiting to happen. This was silently violated
// by JRS-25E until 2026-05-14 — multiple Linus passes on the catalog
// file failed to catch it. Fail load-time so the server refuses to
// start on regression. Extracted to a pure function so the negative
// case is unit-testable without poking the module's internal const
// arrays.
//
// Predicate is `!== 'direct'` rather than `=== 'ecommerce'` so a future
// edit that introduces a typo ('Ecommerce', 'e-commerce') or a new
// channel value ('web', 'partner') doesn't slip past the guard. The
// safe default above 20 HP is phone-sales — anything not explicitly
// 'direct' is untrusted.
function assertDirectSalesAbove20Hp(catalog) {
  for (const m of catalog) {
    if (m.hp > 20 && m.salesChannel !== 'direct') {
      throw new Error(
        `compressor-catalog: hard-rule violation. ${m.model} (${m.hp} HP) ` +
        `has salesChannel='${m.salesChannel}'. >20 HP must be 'direct' per ` +
        `feedback_cas_pricing_boundary.md.`
      );
    }
  }
}
assertDirectSalesAbove20Hp(COMPRESSOR_CATALOG);

// Module-init invariant: salesChannel:'ecommerce' implies a LIVE joruva.com
// listing, which cannot exist without a real MSRP. So 'ecommerce' REQUIRES
// pricingStatus:'confirmed' AND a non-null price. The contradictory state
// (ecommerce + pending/null-price) means a web visitor is "routed" to a listing
// that doesn't exist — the bug behind nucleus-phone-oqv (JRS-20E shipped as
// ecommerce+pending). Encoded as a load-time throw + pure, unit-testable
// predicate so the contradiction can't silently reappear (same idiom as
// assertDirectSalesAbove20Hp). The fix for a pending-price web-eligible SKU is
// salesChannel:'direct' until CAS confirms the MSRP, then flip back to
// 'ecommerce' + 'confirmed' + price.
function assertEcommerceImpliesConfirmedPrice(catalog) {
  for (const m of catalog) {
    if (m.salesChannel === 'ecommerce' && !(m.pricingStatus === 'confirmed' && m.price != null)) {
      throw new Error(
        `compressor-catalog: contradiction. ${m.model} has salesChannel='ecommerce' ` +
        `but pricingStatus='${m.pricingStatus}' / price=${m.price}. An 'ecommerce' SKU ` +
        `requires pricingStatus='confirmed' and a non-null price (no web listing can ` +
        `exist without an MSRP). Set salesChannel='direct' while pricing is pending, ` +
        `or supply price + pricingStatus='confirmed'.`
      );
    }
  }
}
assertEcommerceImpliesConfirmedPrice(COMPRESSOR_CATALOG);

module.exports = {
  COMPRESSOR_CATALOG,
  RS_OPEN_FRAME,
  PM_VSD,
  LARGE_FRAME,
  PERSONA_DEFAULTS,
  GENERIC_PERSONA_DEFAULT,
  personaDefaultsFor,
  pricedModelAtOrAbove,
  assertDirectSalesAbove20Hp,
  assertEcommerceImpliesConfirmedPrice,
};
