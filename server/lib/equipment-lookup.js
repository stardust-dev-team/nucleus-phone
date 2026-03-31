/**
 * equipment-lookup.js — DB-first equipment lookup with Claude web search fallback.
 *
 * Priority chain:
 *   1. Exact match (manufacturer + model)
 *   2. Variant match (model_variants array)
 *   3. Fuzzy match (Levenshtein ≤ 2)
 *   4. Claude web search (one-time, auto-inserts with confidence='unverified')
 */

const {
  findByManufacturerModel,
  findByVariant,
  findFuzzy,
  insertEquipment,
} = require('./equipment-db');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_TIMEOUT = 15000;

// In-flight dedup: prevents concurrent web searches for the same equipment.
// Map<'mfg:model', Promise<result>> — second concurrent caller awaits the same
// promise. If that promise resolves to null (timeout, bad API key, etc.), both
// callers get null. This is intentional: a later retry (after inFlight is cleared
// in the finally block) will fire a fresh web search.
const inFlight = new Map();

const SEARCH_SYSTEM_PROMPT = `You are an industrial equipment specialist. Given a manufacturer and model number, find the compressed air requirements for this equipment.

Return ONLY valid JSON with these fields:
{
  "manufacturer": "exact manufacturer name",
  "model": "exact model number",
  "category": "cnc_mill|cnc_lathe|cnc_router|packaging|paint|sandblast|woodworking|general_pneumatic",
  "subcategory": "optional finer category",
  "cfm_min": number or null,
  "cfm_max": number or null,
  "cfm_typical": number (best estimate of typical CFM usage),
  "psi_required": number (typically 90-125 for most equipment),
  "duty_cycle_pct": number (0-100, how much of the time it uses air),
  "air_quality_class": "ISO_8573_1|general|paint_grade" or null,
  "power_hp": number or null,
  "voltage": "230V/3ph" or similar string or null,
  "description": "one-line description of the equipment",
  "typical_applications": ["array of common uses"],
  "industries": ["aerospace","automotive","general_machining", etc]
}

If you cannot find reliable specs, estimate based on similar equipment in the same category. Set cfm_typical to your best estimate — an approximation is more useful than null.`;

/**
 * Look up equipment specs. Returns catalog+details row or null.
 */
async function lookupEquipment(manufacturer, model) {
  if (!manufacturer || !model) return null;

  // Step 1: exact match
  const exact = await findByManufacturerModel(manufacturer, model);
  if (exact) return exact;

  // Step 2: variant match
  const variant = await findByVariant(manufacturer, model);
  if (variant) return variant;

  // Step 3: fuzzy match
  const fuzzy = await findFuzzy(manufacturer, model);
  if (fuzzy) return fuzzy;

  // Step 4: Claude web search (with concurrent dedup)
  const key = `${manufacturer.toLowerCase()}:${model.toLowerCase()}`;
  if (inFlight.has(key)) {
    return inFlight.get(key);
  }

  const promise = webSearchAndInsert(manufacturer, model, key);
  inFlight.set(key, promise);
  return promise;
}

async function webSearchAndInsert(manufacturer, model, dedupKey) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('equipment-lookup: ANTHROPIC_API_KEY not set — skipping web search');
    inFlight.delete(dedupKey);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SEARCH_SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305' }],
        messages: [{
          role: 'user',
          content: `Find the compressed air requirements for: ${manufacturer} ${model}`,
        }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`equipment-lookup web search failed: ${res.status}`);
      return null;
    }

    const data = await res.json();

    // Extract text content from response (may have tool_use + text blocks)
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock?.text) return null;

    let specs;
    try {
      const cleaned = textBlock.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      specs = JSON.parse(cleaned);
    } catch {
      console.error('equipment-lookup: failed to parse web search response');
      return null;
    }

    // Auto-insert with confidence='unverified'
    const catalogData = {
      manufacturer: specs.manufacturer || manufacturer,
      model: specs.model || model,
      category: specs.category || 'general_pneumatic',
      subcategory: specs.subcategory || null,
      cfm_min: specs.cfm_min,
      cfm_max: specs.cfm_max,
      cfm_typical: specs.cfm_typical,
      psi_required: specs.psi_required,
      duty_cycle_pct: specs.duty_cycle_pct,
      air_quality_class: specs.air_quality_class,
      power_hp: specs.power_hp,
      voltage: specs.voltage,
      source: 'web_search',
      confidence: 'unverified',
    };

    const detailsData = {
      description: specs.description,
      typical_applications: specs.typical_applications,
      industries: specs.industries,
    };

    const result = await insertEquipment(catalogData, detailsData);
    if (result.error) return null;

    // Re-fetch to return the full joined row
    return findByManufacturerModel(
      specs.manufacturer || manufacturer,
      specs.model || model
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('equipment-lookup: web search timed out');
    } else {
      console.error('equipment-lookup web search error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timeout);
    inFlight.delete(dedupKey);
  }
}

module.exports = { lookupEquipment };
