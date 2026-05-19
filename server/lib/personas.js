/**
 * personas.js — single source of truth for sim persona metadata + assistant
 * env-var mapping. Backs GET /api/sim/personas and the per-call assistant
 * lookup used by sim-call initiators.
 *
 * The PWA path through routes/sim.js still uses its own DIFFICULTY_TO_ASSISTANT
 * map for backward compat; the new iOS path (M3 Phase B2a, B2b) goes through
 * resolveAssistantId() here. Both paths converge on the same env vars via the
 * legacy-fallback below.
 */

const fs = require('fs');
const path = require('path');

const PERSONAS_PATH = path.join(__dirname, '..', '..', 'config', 'sim-personas', 'personas.json');

let cache = null;

function loadPersonas() {
  if (cache) return cache;
  const raw = fs.readFileSync(PERSONAS_PATH, 'utf-8');
  cache = JSON.parse(raw);
  return cache;
}

/**
 * Public personas list — the shape served by GET /api/sim/personas.
 * Strips `assistantEnvVars` (internal mapping, not part of the public contract).
 *
 * Architecture B (the active choice as of 2026-05-19): no `assistantInboundNumbers`
 * field. If we ever flip to Architecture A, add the field to personas.json and
 * include it here.
 */
function listPersonas() {
  return loadPersonas().map(({ assistantEnvVars, ...publicFields }) => publicFields);
}

/**
 * Resolve a persona+difficulty pair to the Vapi assistant ID currently set on
 * the running process. Returns undefined when neither the new env var nor the
 * legacy fallback is set — caller decides between 500 (server misconfig) and
 * 404 (unknown persona/difficulty).
 *
 * Precedence:
 *   1. `process.env[persona.assistantEnvVars[difficulty]]` (the new var name).
 *   2. `process.env["VAPI_SIM_" + difficulty.toUpperCase() + "_ID"]` (legacy fallback).
 *   3. undefined.
 *
 * Empty-string env values are treated as unset at each step (Render's UI can't
 * save "" by accident, but JS test setups can). If a future use case needs
 * "explicit empty = disable this slot, do NOT fall through", change this — the
 * test at sim-lib/personas.test.js "empty-string env value is treated as unset"
 * pins the current behavior.
 *
 * Returns undefined when persona is unknown or the difficulty is not in
 * persona.difficulties — keeps callers from accidentally getting a legacy
 * fallback for a persona/difficulty pair that doesn't exist.
 */
function resolveAssistantId({ personaId, difficulty }) {
  const personas = loadPersonas();
  const persona = personas.find((p) => p.id === personaId);
  if (!persona) return undefined;
  if (!persona.difficulties.includes(difficulty)) return undefined;
  const newVarName = persona.assistantEnvVars?.[difficulty];
  if (newVarName && process.env[newVarName]) return process.env[newVarName];
  const legacyVarName = `VAPI_SIM_${difficulty.toUpperCase()}_ID`;
  return process.env[legacyVarName] || undefined;
}

/**
 * Validate the persona config against the current process env. Warns (does
 * not throw) for each persona/difficulty slot that resolves to undefined
 * after fallback. Intended to be called once from server bootstrap, AFTER
 * dotenv + requireEnv have populated process.env.
 *
 * Returns the count of slots that failed to resolve, so callers can decide
 * whether to surface it in a /health response or just rely on the warn-only
 * deploy-log behavior.
 */
function validatePersonaConfig() {
  const personas = loadPersonas();
  let missing = 0;
  for (const persona of personas) {
    for (const difficulty of persona.difficulties) {
      const resolved = resolveAssistantId({ personaId: persona.id, difficulty });
      if (!resolved) {
        missing += 1;
        const newVar = persona.assistantEnvVars?.[difficulty];
        const legacyVar = `VAPI_SIM_${difficulty.toUpperCase()}_ID`;
        console.warn(
          `SIM personas: no Vapi assistant ID for ${persona.id}/${difficulty} ` +
          `(checked ${newVar} → ${legacyVar}). Calls for this slot will 500.`
        );
      }
    }
  }
  return missing;
}

module.exports = {
  listPersonas,
  resolveAssistantId,
  validatePersonaConfig,
  _resetCache: () => { cache = null; },
};
