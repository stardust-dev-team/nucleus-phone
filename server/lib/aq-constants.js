/**
 * aq-constants.js — Air quality priority ranking.
 *
 * Single source of truth. Imported by equipment-pipeline.js and live-analysis.js.
 * If you add a tier (e.g. food_grade, semiconductor), add it here — nowhere else.
 */

const AQ_RANK = { ISO_8573_1: 2, paint_grade: 1, general: 0 };

module.exports = { AQ_RANK };
