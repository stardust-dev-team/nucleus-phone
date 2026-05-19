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
 * Strips `assistantEnvVars` (server-only secret-ish metadata) before returning.
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
 * Legacy fallback: VAPI_SIM_{DIFFICULTY}_ID. This is what the PWA was using
 * before this helper existed; keeping it here means the PWA can migrate to
 * resolveAssistantId() without an env-var rename on Render between deploys.
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
 * Startup validation — warns (does not crash) when an `assistantEnvVars` entry
 * resolves to undefined after fallback. Keeps the PWA path working unchanged
 * while flagging Render env-var drift in deploy logs.
 */
function validateOnStartup() {
  const personas = loadPersonas();
  for (const persona of personas) {
    for (const difficulty of persona.difficulties) {
      const resolved = resolveAssistantId({ personaId: persona.id, difficulty });
      if (!resolved) {
        const newVar = persona.assistantEnvVars?.[difficulty];
        const legacyVar = `VAPI_SIM_${difficulty.toUpperCase()}_ID`;
        console.warn(
          `SIM personas: no Vapi assistant ID for ${persona.id}/${difficulty} ` +
          `(checked ${newVar} → ${legacyVar}). Calls for this slot will 500.`
        );
      }
    }
  }
}

validateOnStartup();

module.exports = {
  listPersonas,
  resolveAssistantId,
  _resetCacheForTests: () => { cache = null; },
};
