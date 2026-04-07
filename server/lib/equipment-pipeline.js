/**
 * equipment-pipeline.js — Shared entity extraction → lookup → sizing pipeline.
 *
 * Used by both Twilio RT transcription (real calls) and Vapi transcript events
 * (practice calls). Extracts equipment mentions, looks up specs, logs sightings,
 * broadcasts to WebSocket, and recalculates sizing recommendations.
 */

const { extractEquipment } = require('./entity-extractor');
const { lookupEquipment } = require('./equipment-lookup');
const { calculateDemand, recommendSystem, addQualityFilters, deriveSalesChannel } = require('./sizing-engine');
const { logSighting } = require('./equipment-db');
const { broadcast, getCallEquipment } = require('./live-analysis');
const { addVariant } = require('./equipment-curator');

// Default CFM estimates for equipment categories when no specific model is matched.
// Based on manufacturer pre-install guides, industry standards, and forum data.
// Conservative midpoints — better to slightly undersize than miss entirely (0 CFM).
const CATEGORY_DEFAULTS = {
  // CNC metalworking
  cnc:          { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  mill:         { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  vmc:          { cfm_typical: 8,   psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  hmc:          { cfm_typical: 10,  psi_required: 90,  duty_cycle_pct: 75, air_quality_class: 'general' },
  lathe:        { cfm_typical: 5,   psi_required: 90,  duty_cycle_pct: 70, air_quality_class: 'general' },
  turning:      { cfm_typical: 5,   psi_required: 90,  duty_cycle_pct: 70, air_quality_class: 'general' },
  // CNC woodworking / routing
  router:       { cfm_typical: 15,  psi_required: 90,  duty_cycle_pct: 80, air_quality_class: 'general' },
  // Surface treatment
  paint:        { cfm_typical: 20,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  booth:        { cfm_typical: 20,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  spray:        { cfm_typical: 15,  psi_required: 50,  duty_cycle_pct: 60, air_quality_class: 'paint_grade' },
  blast:        { cfm_typical: 100, psi_required: 100, duty_cycle_pct: 50, air_quality_class: 'general' },
  sandblast:    { cfm_typical: 100, psi_required: 100, duty_cycle_pct: 50, air_quality_class: 'general' },
  // Packaging
  packaging:    { cfm_typical: 10,  psi_required: 80,  duty_cycle_pct: 60, air_quality_class: 'general' },
  erector:      { cfm_typical: 8,   psi_required: 80,  duty_cycle_pct: 60, air_quality_class: 'general' },
  // General pneumatic
  press:        { cfm_typical: 10,  psi_required: 90,  duty_cycle_pct: 50, air_quality_class: 'general' },
  grinder:      { cfm_typical: 6,   psi_required: 90,  duty_cycle_pct: 60, air_quality_class: 'general' },
  welder:       { cfm_typical: 5,   psi_required: 80,  duty_cycle_pct: 40, air_quality_class: 'general' },
};

// Known CNC manufacturers — when we see "Haas" with no model, apply CNC defaults
const CNC_MANUFACTURERS = new Set([
  'haas', 'mazak', 'okuma', 'dmg', 'mori', 'doosan', 'fanuc', 'hurco',
  'kitamura', 'makino', 'matsuura', 'brother', 'hyundai', 'hardinge',
  'nakamura', 'samsung', 'spinner', 'takisawa', 'tsugami', 'miyano',
  'citizen', 'star', 'tornos', 'daewoo', 'bridgeport',
]);

/**
 * Get default specs for an equipment entity that didn't match the catalog.
 * Uses manufacturer name, model keywords, and raw mention to infer category.
 */
function getCategoryDefault(entity) {
  const text = [entity.manufacturer, entity.model, entity.raw_mention]
    .filter(Boolean).join(' ').toLowerCase();

  // Check known CNC manufacturers first
  if (entity.manufacturer && CNC_MANUFACTURERS.has(entity.manufacturer.toLowerCase())) {
    return { ...CATEGORY_DEFAULTS.cnc, confidence: 'category_default' };
  }

  // Match keywords in the combined text
  for (const [keyword, defaults] of Object.entries(CATEGORY_DEFAULTS)) {
    if (text.includes(keyword)) {
      return { ...defaults, confidence: 'category_default' };
    }
  }

  return null;
}

/**
 * Process a transcript chunk through the equipment detection pipeline.
 *
 * @param {string} callId   - WebSocket broadcast channel (e.g. 'conf_abc' or 'sim-42')
 * @param {string} callType - 'real' or 'practice' (for equipment_sightings)
 * @param {string} dbCallId - Database row ID (string) for sighting logging
 * @param {string} text     - Transcript text to process
 */
async function processEquipmentChunk(callId, callType, dbCallId, text) {
  const entities = await extractEquipment(text);
  if (entities.length === 0) return;

  const accumulated = getCallEquipment(callId);
  let sizingChanged = false;

  for (const entity of entities) {
    try {
      let result = null;
      if (entity.manufacturer && entity.model) {
        result = await lookupEquipment(entity.manufacturer, entity.model);
      }

      // If no catalog match, apply category defaults based on equipment type.
      // "4 CNC machines" with no model → 8 CFM each instead of 0 CFM.
      const categoryFallback = !result ? getCategoryDefault(entity) : null;

      const specs = result ? {
        cfm_typical: result.cfm_typical,
        psi_required: result.psi_required,
        duty_cycle_pct: result.duty_cycle_pct,
        air_quality_class: result.air_quality_class,
        confidence: result.confidence,
      } : categoryFallback ? {
        cfm_typical: categoryFallback.cfm_typical,
        psi_required: categoryFallback.psi_required,
        duty_cycle_pct: categoryFallback.duty_cycle_pct,
        air_quality_class: categoryFallback.air_quality_class,
        confidence: categoryFallback.confidence,
      } : null;

      // Learn variant: if lookup matched but extracted model differs from canonical,
      // persist the alias so future lookups hit Step 2 (variant match) instead of Step 3 (fuzzy).
      if (result) {
        const canonical = result.model.toLowerCase();
        const newVariants = new Set();
        if (entity.model && entity.model.toLowerCase() !== canonical) newVariants.add(entity.model);
        if (entity.raw_mention && entity.raw_mention.toLowerCase() !== canonical) newVariants.add(entity.raw_mention);
        for (const v of newVariants) addVariant(result.id, v).catch(() => {}); // fire-and-forget; addVariant logs internally
      }

      await logSighting({
        manufacturer: entity.manufacturer,
        model: entity.model,
        raw_mention: entity.raw_mention,
        count: entity.count,
        call_type: callType,
        call_id: dbCallId,
        catalog_match_id: result?.id ?? null,
      });

      broadcast(callId, {
        type: 'equipment_detected',
        data: {
          manufacturer: entity.manufacturer,
          model: entity.model,
          count: entity.count,
          specs,
          catalogMatch: !!result,
        },
      });

      const cfm = parseFloat(specs?.cfm_typical) || 0;
      if (cfm > 0 && accumulated.length < 100) {
        accumulated.push({
          cfm_typical: cfm,
          duty_cycle_pct: parseInt(specs.duty_cycle_pct, 10) || 50,
          psi_required: parseInt(specs.psi_required, 10) || 90,
          air_quality_class: specs.air_quality_class || 'general',
          count: entity.count,
        });
        sizingChanged = true;
      }
    } catch (err) {
      console.error(`equipment-pipeline: failed for ${entity.manufacturer} ${entity.model}:`, err.message);
    }
  }

  if (sizingChanged) {
    const demand = calculateDemand(accumulated);
    broadcast(callId, { type: 'sizing_updated', data: demand });

    const recommendation = recommendSystem(demand);
    if (recommendation) {
      // Derive air quality class from accumulated equipment (priority: ISO > paint > general)
      const AQ_PRIORITY = { ISO_8573_1: 2, paint_grade: 1 };
      let bestAq = null;
      let bestPriority = 0;
      for (const item of accumulated) {
        const p = AQ_PRIORITY[item.air_quality_class] || 0;
        if (p > bestPriority) {
          bestPriority = p;
          bestAq = item.air_quality_class;
        }
      }
      addQualityFilters(recommendation, bestAq);
      deriveSalesChannel(recommendation);
      broadcast(callId, { type: 'recommendation_ready', data: recommendation });
    }
  }
}

module.exports = { processEquipmentChunk };
