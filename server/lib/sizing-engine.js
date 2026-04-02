/**
 * sizing-engine.js — Deterministic compressed air system sizing.
 *
 * No AI calls. Pure math: sum CFM at duty cycle, apply safety factor,
 * map to CAS product catalog.
 */

const { COMPRESSOR_CATALOG } = require('./compressor-catalog');

const SAFETY_FACTOR = 1.25; // Industry standard: 25% buffer for leaks + growth

// CAS refrigerated air dryers.
// 30-100 CFM: stocked, ~45% gross margin, ecommerce.
// 200+ CFM: placeholder Joruva SKUs, pricing TBD from CAS.
const DRYER_CATALOG = [
  { model: 'JRD-30',   cfm: 30,   voltage: '115V/1/60',  cost: 1197, price: 2195, cas_sku: 'RD30',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRD-40',   cfm: 40,   voltage: '115V/1/60',  cost: 1340, price: 2495, cas_sku: 'RD40',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRD-60',   cfm: 60,   voltage: '115V/1/60',  cost: 1569, price: 2895, cas_sku: 'RD60',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRD-80',   cfm: 80,   voltage: '115V/1/60',  cost: 1718, price: 3195, cas_sku: 'RD80',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRD-100',  cfm: 100,  voltage: '115V/1/60',  cost: 1976, price: 3595, cas_sku: 'RD100', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JRD-200',  cfm: 200,  voltage: '230V/1/60',  cost: null, price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRD-500',  cfm: 500,  voltage: '230V/3/60',  cost: null, price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRD-1000', cfm: 1000, voltage: '460V/3/60',  cost: null, price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JRD-2000', cfm: 2000, voltage: '460V/3/60',  cost: null, price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
];

// CAS wall-mount desiccant dryers — -60°F dewpoint.
// Molecular sieve media (not activated alumina) — premium product class.
// 6061 billet aluminum housing, spin-on canister.
// 200+ CFM: placeholder SKUs, pricing TBD.
const DESICCANT_CATALOG = [
  { model: 'JDD-40',   cfm: 40,  voltage: '115V', dewpoint: -60, cost: 4705, price: 7495,  cas_sku: 'SODD10HPN4NY', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JDD-80',   cfm: 80,  voltage: '115V', dewpoint: -60, cost: 6525, price: 11895, cas_sku: 'SODD20HPN4NY', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
  { model: 'JDD-200',  cfm: 200, voltage: '230V', dewpoint: -60, cost: null, price: null,  cas_sku: null,           salesChannel: 'direct',    pricingStatus: 'quote_required' },
  { model: 'JDD-500',  cfm: 500, voltage: '460V', dewpoint: -60, cost: null, price: null,  cas_sku: null,           salesChannel: 'direct',    pricingStatus: 'quote_required' },
];

// CAS inline filters.
// 70/130 CFM: stocked, ~49% gross margin, ecommerce.
// 500/1000 CFM: placeholder Joruva SKUs for large systems.
const FILTER_SIZES = {
  particulate: [
    { model: 'JPF-70',   cfm: 70,   micron: 1,    cost: 229.00, price: 399, cas_sku: 'PF-70',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
    { model: 'JPF-130',  cfm: 130,  micron: 1,    cost: 229.00, price: 499, cas_sku: 'PF-130', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
    { model: 'JPF-500',  cfm: 500,  micron: 1,    cost: null,   price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
    { model: 'JPF-1000', cfm: 1000, micron: 1,    cost: null,   price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
  ],
  coalescing: [
    { model: 'JCF-70',   cfm: 70,   micron: 0.01, cost: 176.50, price: 349, cas_sku: 'CF-70',  salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
    { model: 'JCF-130',  cfm: 130,  micron: 0.01, cost: 229.00, price: 449, cas_sku: 'CF-130', salesChannel: 'ecommerce', pricingStatus: 'confirmed' },
    { model: 'JCF-500',  cfm: 500,  micron: 0.01, cost: null,   price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
    { model: 'JCF-1000', cfm: 1000, micron: 0.01, cost: null,   price: null, cas_sku: null,    salesChannel: 'direct',    pricingStatus: 'quote_required' },
  ],
};

// Backward compat — legacy code references FILTER_CATALOG (the 130 CFM tier).
const FILTER_CATALOG = {
  particulate: FILTER_SIZES.particulate.find(f => f.model === 'JPF-130'),
  coalescing:  FILTER_SIZES.coalescing.find(f => f.model === 'JCF-130'),
};

function selectFilter(type, cfm) {
  const sizes = FILTER_SIZES[type];
  return sizes.find(f => f.cfm >= cfm) || sizes[sizes.length - 1];
}

/**
 * Calculate total air demand from a list of equipment.
 * Each item: { cfm_typical, cfm_max, duty_cycle_pct, psi_required, count }
 *
 * Returns null if equipmentList is empty or has no CFM data.
 */
function calculateDemand(equipmentList) {
  if (!equipmentList || equipmentList.length === 0) return null;

  let totalCfmAtDuty = 0;
  let peakCfm = 0;
  let maxPsi = 0;
  let equipmentCount = 0;

  for (const item of equipmentList) {
    const cfmTypical = parseFloat(item.cfm_typical) || 0;
    const cfmMax = parseFloat(item.cfm_max) || cfmTypical;
    const rawDuty = parseInt(item.duty_cycle_pct, 10);
    const dutyCycle = (Number.isNaN(rawDuty) ? 100 : rawDuty) / 100;
    const psi = parseInt(item.psi_required, 10) || 0;
    const rawCount = parseInt(item.count, 10);
    const count = rawCount > 0 ? rawCount : 1;

    totalCfmAtDuty += cfmTypical * dutyCycle * count;
    peakCfm += cfmMax * count;
    if (psi > maxPsi) maxPsi = psi;
    equipmentCount += count;
  }

  if (totalCfmAtDuty === 0 && peakCfm === 0) return null;

  const adjustedCfm = Math.ceil(totalCfmAtDuty * SAFETY_FACTOR);
  const adjustedPeak = Math.ceil(peakCfm * SAFETY_FACTOR);

  return {
    totalCfmAtDuty: Math.round(totalCfmAtDuty * 10) / 10,
    peakCfm: Math.round(peakCfm * 10) / 10,
    adjustedCfm,
    adjustedPeak,
    maxPsi: maxPsi || 90,
    equipmentCount,
  };
}

/**
 * Recommend a CAS compressed air system based on demand.
 * Returns null if demand is null.
 *
 * When demand exceeds the largest single unit, builds a parallel
 * configuration instead of just noting "consider parallel."
 */
function recommendSystem(demand) {
  if (!demand) return null;

  const largest = COMPRESSOR_CATALOG[COMPRESSOR_CATALOG.length - 1];
  let compressor;
  let parallelConfig = null;

  if (demand.adjustedCfm <= largest.cfm) {
    // Prefer RS Open Frame / Large Frame (standard lines) over PM/VSD (premium upsell).
    // Only fall back to PM/VSD if no standard model fits the demand.
    compressor = COMPRESSOR_CATALOG.find(c =>
      c.cfm >= demand.adjustedCfm && (c.productLine === 'rs_open' || c.productLine === 'large_frame')
    ) || COMPRESSOR_CATALOG.find(c => c.cfm >= demand.adjustedCfm);
  } else {
    // Parallel configuration: N identical units of the largest model
    compressor = largest;
    const unitCount = Math.ceil(demand.adjustedCfm / largest.cfm);
    parallelConfig = {
      units: Array.from({ length: unitCount }, () => ({ ...largest })),
      totalCfm: unitCount * largest.cfm,
      unitCount,
      configuration: 'parallel',
    };
  }

  // Dryer: size to total system CFM (parallel totalCfm or single unit cfm)
  const dryerCfm = parallelConfig ? parallelConfig.totalCfm : compressor.cfm;
  const dryer = DRYER_CATALOG.find(d => d.cfm >= dryerCfm)
    || DRYER_CATALOG[DRYER_CATALOG.length - 1];

  // Particulate pre-filter sized to single compressor output.
  // In parallel configs each compressor has its own filter train.
  const filters = [selectFilter('particulate', compressor.cfm)];

  const notes = [];

  // Flag undersized dryer in parallel configs
  if (parallelConfig && dryer.cfm < parallelConfig.totalCfm) {
    notes.push(`Dryer (${dryer.model}, ${dryer.cfm} CFM) undersized for parallel system (${parallelConfig.totalCfm} CFM total) — multiple dryers or custom sizing required`);
  }

  if (demand.maxPsi > 125) {
    notes.push(`High PSI requirement (${demand.maxPsi}) — verify equipment specs`);
  }

  return {
    compressor: { ...compressor },
    parallelConfig,
    dryer: { ...dryer },
    filters: filters.map(f => ({ ...f })),
    demand: { ...demand },
    notes,
    // salesChannel and pricingStatus are set by deriveSalesChannel() after
    // addQualityFilters() has had a chance to add desiccant upgrades.
    salesChannel: null,
    pricingStatus: null,
  };
}

/**
 * Mutates recommendation in-place: adds coalescing filter when air quality
 * class requires it (AS9100/ISO_8573_1, paint grade). No return value.
 */
function addQualityFilters(recommendation, airQualityClass) {
  if (!recommendation || !airQualityClass) return;

  const needsCoalescing = airQualityClass === 'ISO_8573_1' || airQualityClass === 'paint_grade';
  if (needsCoalescing) {
    const hasCoalescing = recommendation.filters.some(f => f.micron <= 0.01);
    if (!hasCoalescing) {
      const cfm = recommendation.compressor?.cfm || 55;
      recommendation.filters.push({ ...selectFilter('coalescing', cfm) });
      recommendation.notes.push('Coalescing filter added for air quality requirements');
    }

    // Desiccant upgrade sized to single compressor CFM (each compressor has
    // its own air treatment loop in parallel configs).
    const desiccant = DESICCANT_CATALOG.find(d => d.cfm >= (recommendation.compressor?.cfm || 40))
      || DESICCANT_CATALOG[DESICCANT_CATALOG.length - 1];
    recommendation.desiccantUpgrade = { ...desiccant };
    const desiccantCount = recommendation.parallelConfig ? recommendation.parallelConfig.unitCount : 1;
    const desiccantQty = desiccantCount > 1 ? `${desiccantCount}x ` : '';
    recommendation.notes.push(
      `Consider desiccant dryer upgrade (${desiccantQty}${desiccant.model}, ${desiccant.price ? '$' + desiccant.price.toLocaleString() + (desiccantCount > 1 ? ' each' : '') : 'quote required'}) — molecular sieve media achieves ${desiccant.dewpoint}°F dewpoint vs 38°F refrigerated. Required for AS9100/pharma.`
    );
  }
}

/**
 * Derive top-level salesChannel and pricingStatus from all components.
 * Must be called AFTER addQualityFilters() so desiccant upgrades are included.
 *
 * salesChannel = 'direct' if ANY component is direct.
 * pricingStatus = 'quote_required' if ANY component is quote_required.
 */
function deriveSalesChannel(recommendation) {
  if (!recommendation) return;

  const components = [
    recommendation.compressor,
    recommendation.dryer,
    ...recommendation.filters,
  ];
  if (recommendation.desiccantUpgrade) {
    components.push(recommendation.desiccantUpgrade);
  }
  if (recommendation.parallelConfig) {
    // Parallel is always direct
    recommendation.salesChannel = 'direct';
  } else {
    recommendation.salesChannel = components.some(c => c.salesChannel === 'direct')
      ? 'direct' : 'ecommerce';
  }

  recommendation.pricingStatus = components.some(c => c.pricingStatus === 'quote_required')
    ? 'quote_required' : 'confirmed';
}

module.exports = {
  calculateDemand,
  recommendSystem,
  addQualityFilters,
  deriveSalesChannel,
  selectFilter,
  SAFETY_FACTOR,
  COMPRESSOR_CATALOG,
  DRYER_CATALOG,
  DESICCANT_CATALOG,
  FILTER_CATALOG,
  FILTER_SIZES,
};
