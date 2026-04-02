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
// 5-25HP: existing Joruva ecommerce SKUs (JRS-{HP}E pattern).
// 30HP+: direct sale only, pricing TBD from CAS.
const RS_OPEN_FRAME = [
  { model: 'JRS-5E',    hp: 5,    cfm: 18,  psi: 150, price: null,  voltage: '230V/1ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'pending' },
  { model: 'JRS-7.5E',  hp: 7.5,  cfm: 28,  psi: 150, price: 7495,  voltage: '230V/1ph or 3ph',   productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRS-10E',   hp: 10,   cfm: 38,  psi: 150, price: 9495,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRS-15E',   hp: 15,   cfm: 54,  psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'pending' },
  { model: 'JRS-20E',   hp: 20,   cfm: 78,  psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'pending' },
  { model: 'JRS-25E',   hp: 25,   cfm: 102, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'ecommerce', pricingStatus: 'pending' },
  { model: 'JRS-30',    hp: 30,   cfm: 125, psi: 150, price: 19500, voltage: '230/460V/3ph',      productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'confirmed' },
  { model: 'JRS-40',    hp: 40,   cfm: 155, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-50',    hp: 50,   cfm: 185, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-60',    hp: 60,   cfm: 210, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-75',    hp: 75,   cfm: 285, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRS-100',   hp: 100,  cfm: 405, psi: 150, price: null,  voltage: '460V/3ph',          productLine: 'rs_open', salesChannel: 'direct',    pricingStatus: 'quote_required' },
];

// --- Permanent Magnet VSD (Enclosed, Variable Speed) — 10 to 150 HP ---
// CFM @ 150 PSI from official CAS PermMagBrochure.pdf.
// IE4 Super Premium motors, zero-loss direct-drive, liquid-cooled.
// All direct sale only.
const PM_VSD = [
  { model: 'JVSD-10',   hp: 10,   cfm: 34,  psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-15',   hp: 15,   cfm: 53,  psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-20',   hp: 20,   cfm: 71,  psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-30',   hp: 30,   cfm: 109, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-50',   hp: 50,   cfm: 187, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-60',   hp: 60,   cfm: 230, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-75',   hp: 75,   cfm: 320, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-100',  hp: 100,  cfm: 406, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-125',  hp: 125,  cfm: 577, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
  { model: 'JVSD-150',  hp: 150,  cfm: 741, psi: 150, price: null, voltage: '208-230-460V/3ph', productLine: 'pm_vsd', salesChannel: 'direct', pricingStatus: 'quote_required' },
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

module.exports = {
  COMPRESSOR_CATALOG,
  RS_OPEN_FRAME,
  PM_VSD,
  LARGE_FRAME,
};
