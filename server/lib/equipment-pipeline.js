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

      const specs = result ? {
        cfm_typical: result.cfm_typical,
        psi_required: result.psi_required,
        duty_cycle_pct: result.duty_cycle_pct,
        air_quality_class: result.air_quality_class,
        confidence: result.confidence,
      } : null;

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
