/**
 * hub-catalog-store.js — TTL-refreshed in-process product catalog from the hub.
 *
 * On startup: seeds from static compressor-catalog.js (immediate availability).
 * Then fetches from hub API and overwrites. Refreshes every 5 min.
 * Force-refresh on product.* webhook via refreshNow().
 */

const HUB_URL = process.env.HUB_URL || 'https://joruva-ucil.onrender.com';
const HUB_ADMIN_EMAIL = process.env.HUB_ADMIN_EMAIL || 'tom@joruva.com';
const HUB_ADMIN_KEY = process.env.HUB_ADMIN_KEY;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;

let catalog = null;
let promptText = null;
let fullCatalogText = null;
let refreshTimer = null;
let hubAvailable = false;

let staticCatalog = null;
try {
  const { COMPRESSOR_CATALOG } = require('./compressor-catalog');
  staticCatalog = COMPRESSOR_CATALOG;
} catch {
  console.warn('[hub-catalog] Static compressor-catalog.js not found');
}

function specVal(specs, group, key) {
  if (!specs) return null;
  const s = specs.find(s => s && s.group === group && s.key === key);
  return s ? s.value : null;
}

function hubProductToLegacy(p) {
  const lineMap = { rotary_screw: 'rs_open', pm_vsd: 'pm_vsd', large_frame: 'large_frame' };
  return {
    model: p.sku,
    hp: specVal(p.specs, 'performance', 'hp') || 0,
    cfm: specVal(p.specs, 'performance', 'cfm') || 0,
    psi: specVal(p.specs, 'performance', 'psi') || 150,
    price: p.price_cents ? p.price_cents / 100 : null,
    voltage: specVal(p.specs, 'electrical', 'voltage') || '',
    productLine: lineMap[p.product_line] || p.product_line,
    salesChannel: p.sales_channel,
    pricingStatus: p.pricing_status,
  };
}

async function fetchFromHub() {
  if (!HUB_ADMIN_KEY) return null;
  if (process.env.USE_HUB_CATALOG === 'false') return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const resp = await fetch(HUB_URL + '/hub/products', {
      headers: { 'X-Hub-Admin-Email': HUB_ADMIN_EMAIL, 'X-Hub-Admin-Key': HUB_ADMIN_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) { console.warn('[hub-catalog] Hub API returned ' + resp.status); return null; }
    const data = await resp.json();
    const products = data.products || [];
    const compressorLines = new Set(['rotary_screw', 'pm_vsd', 'large_frame']);
    const compressors = products.filter(p => compressorLines.has(p.product_line)).map(hubProductToLegacy)
      .sort((a, b) => {
        if (a.cfm !== b.cfm) return a.cfm - b.cfm;
        const pri = { rs_open: 0, large_frame: 1, pm_vsd: 2 };
        return (pri[a.productLine] ?? 9) - (pri[b.productLine] ?? 9);
      });
    const prompt = buildPromptFromHub(products);
    const fullText = products.map(p => {
      const hp = specVal(p.specs, 'performance', 'hp');
      const cfm = specVal(p.specs, 'performance', 'cfm') || specVal(p.specs, 'performance', 'max_cfm');
      const psi = specVal(p.specs, 'performance', 'psi');
      const voltage = specVal(p.specs, 'electrical', 'voltage');
      const price = p.price_cents ? '$' + (p.price_cents / 100).toLocaleString() : 'quote required';
      return p.sku + ': ' + (hp ? hp + 'HP, ' : '') + (cfm ? cfm + 'CFM' : '') + (psi ? ' @ ' + psi + 'PSI' : '') + ', ' + (voltage || '') + (voltage ? ', ' : '') + price + ' (' + p.sales_channel + ')';
    }).join('\n');
    return { compressors, prompt, fullText };
  } catch (err) {
    console.warn('[hub-catalog] Hub fetch failed: ' + (err.name === 'AbortError' ? 'timeout' : err.message));
    return null;
  }
}

function buildPromptFromHub(products) {
  const byLine = {};
  for (const p of products) {
    if (!byLine[p.product_line]) byLine[p.product_line] = [];
    const hp = specVal(p.specs, 'performance', 'hp');
    const cfm = specVal(p.specs, 'performance', 'cfm') || specVal(p.specs, 'performance', 'max_cfm');
    const priceTxt = p.pricing_status === 'confirmed' && p.price_cents ? '$' + (p.price_cents / 100).toLocaleString() : 'quote';
    byLine[p.product_line].push(p.sku + ' ' + (hp ? hp + 'HP ' : '') + (cfm ? cfm + 'CFM ' : '') + priceTxt);
  }
  const lines = [];
  if (byLine.rotary_screw) lines.push('RS Open Frame (fixed-speed, 5-100HP): ' + byLine.rotary_screw.join(' | '));
  if (byLine.pm_vsd) lines.push('Permanent Magnet VSD (enclosed, variable-speed, 10-200HP): ' + byLine.pm_vsd.join(' | '));
  if (byLine.large_frame) lines.push('Large Frame Enclosed (125-476HP): ' + byLine.large_frame.join(' | '));
  if (byLine.dryer_refrigerated) lines.push('Dryers (refrigerated): ' + byLine.dryer_refrigerated.join(' | '));
  if (byLine.dryer_desiccant) lines.push('Dryers (desiccant, -60F, molecular sieve): ' + byLine.dryer_desiccant.join(' | '));
  if (byLine.filter_particulate) lines.push('Filters (particulate, 1um): ' + byLine.filter_particulate.join(' | '));
  if (byLine.filter_coalescing) lines.push('Filters (coalescing, 0.01um): ' + byLine.filter_coalescing.join(' | '));
  if (byLine.ows) lines.push('OWS (oil-water separator): ' + byLine.ows.join(' | '));
  return 'Joruva Industrial products:\n' + lines.join('\n') + '\nRows marked "quote" are direct-sale. Use the get_product_specs tool to confirm current specs, then tell the rep to request a quote (or escalate to Tom).\nFor AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.';
}

function buildStaticPrompt() {
  if (!staticCatalog) return 'Product catalog unavailable.';
  const byLine = { rs_open: [], pm_vsd: [], large_frame: [] };
  for (const c of staticCatalog) {
    if (!byLine[c.productLine]) continue;
    const priceTxt = c.pricingStatus === 'confirmed' && c.price ? '$' + c.price.toLocaleString() : 'quote';
    byLine[c.productLine].push(c.model + ' ' + c.hp + 'HP ' + c.cfm + 'CFM ' + priceTxt);
  }
  const lines = [];
  if (byLine.rs_open.length) lines.push('RS Open Frame (fixed-speed, 5-100HP): ' + byLine.rs_open.join(' | '));
  if (byLine.pm_vsd.length) lines.push('Permanent Magnet VSD (enclosed, variable-speed, 10-200HP): ' + byLine.pm_vsd.join(' | '));
  if (byLine.large_frame.length) lines.push('Large Frame Enclosed (125-476HP): ' + byLine.large_frame.join(' | '));
  return 'Joruva Industrial products:\n' + lines.join('\n') + '\nDryers (refrigerated): JRD-30 $2,195 | JRD-40 $2,495 | JRD-60 $2,895 | JRD-80 $3,195 | JRD-100 $3,595\nDryers (desiccant, -60F, molecular sieve, wall-mount): JDD-40 40CFM $7,495 | JDD-80 80CFM $11,895\nFilters: JPF-70 particulate 1um $399 | JPF-130 $499 | JCF-70 coalescing 0.01um $349 | JCF-130 $449\nOWS (oil-water separator): OWS75 $234 | OWS150 $1,092\nRows marked "quote" are direct-sale. Use the get_product_specs tool to confirm current specs, then tell the rep to request a quote (or escalate to Tom).\nFor AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.';
}

function getCompressorCatalog() { return catalog || staticCatalog || []; }
function getProductCatalog() { return promptText || buildStaticPrompt(); }
function getFullCatalogText() {
  if (fullCatalogText) return fullCatalogText;
  const cat = getCompressorCatalog();
  return cat.map(c => c.model + ': ' + c.hp + 'HP, ' + c.cfm + 'CFM @ ' + c.psi + 'PSI, ' + c.voltage + (c.price ? ', $' + c.price.toLocaleString() : ', quote required') + ' (' + c.salesChannel + ')').join('\n');
}
function isHubAvailable() { return hubAvailable; }

async function refreshNow() {
  const result = await fetchFromHub();
  if (result) {
    catalog = result.compressors;
    promptText = result.prompt;
    fullCatalogText = result.fullText;
    hubAvailable = true;
    console.log('[hub-catalog] Refreshed: ' + catalog.length + ' compressors, ' + result.fullText.split('\n').length + ' total products');
  } else {
    hubAvailable = false;
  }
}

function startRefreshLoop() {
  if (staticCatalog) { catalog = staticCatalog; promptText = buildStaticPrompt(); }
  refreshNow().catch(() => {});
  refreshTimer = setInterval(() => { refreshNow().catch(() => {}); }, REFRESH_INTERVAL_MS);
  refreshTimer.unref();
}

function stopRefreshLoop() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

module.exports = { getCompressorCatalog, getProductCatalog, getFullCatalogText, isHubAvailable, refreshNow, startRefreshLoop, stopRefreshLoop };
