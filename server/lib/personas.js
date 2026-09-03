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

const DEFAULT_PERSONA_ID = 'mike-garza';

/**
 * The persona the PWA practice path (`POST /api/sim/call`) currently serves,
 * chosen by the `SIM_ACTIVE_PERSONA` env var. Defaults to 'mike-garza' so an
 * unset env behaves exactly as it did before personas were parametrized.
 *
 * An env value that names a persona not in personas.json is IGNORED (falls back
 * to the default) with a one-time warn — a typo in a Render env var must not
 * take practice offline, and silently is worse than loudly. Empty string is
 * treated as unset.
 */
let activePersonaWarned = false;
function activePersonaId() {
  const raw = process.env.SIM_ACTIVE_PERSONA;
  if (!raw) return DEFAULT_PERSONA_ID;
  const known = loadPersonas().some((p) => p.id === raw);
  if (known) return raw;
  if (!activePersonaWarned) {
    console.warn(
      `SIM_ACTIVE_PERSONA=${JSON.stringify(raw)} is not a known persona id — ` +
      `falling back to '${DEFAULT_PERSONA_ID}'. Known: ${loadPersonas().map((p) => p.id).join(', ')}.`
    );
    activePersonaWarned = true;
  }
  return DEFAULT_PERSONA_ID;
}

/** Full persona record (incl. assistantEnvVars) by id, or undefined. */
function getPersona(personaId) {
  return loadPersonas().find((p) => p.id === personaId);
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
const PROMPT_DIR = path.join(__dirname, '..', '..', 'config', 'sim-personas');
const SIM_CONTACTS_DIR = path.join(__dirname, '..', 'config', 'sim-contacts');

function validatePersonaConfig() {
  const { GREETING_POOLS } = require('./sim-greetings');
  const personas = loadPersonas();
  let missing = 0;

  for (const persona of personas) {
    // Per-persona assets that are NOT keyed by difficulty: greeting pool +
    // base sim-contact briefing. A missing greeting pool is the nastiest drift
    // — pickGreeting silently falls back to the default persona, so the call
    // opens with the WRONG identity rather than crashing. Surface it at boot.
    if (!GREETING_POOLS[persona.id]) {
      missing += 1;
      console.warn(
        `SIM personas: no greeting pool for ${persona.id} in lib/sim-greetings.js ` +
        `— calls would open with the default persona's greeting (wrong identity).`
      );
    }
    if (!fs.existsSync(path.join(SIM_CONTACTS_DIR, `${persona.id}.json`))) {
      missing += 1;
      console.warn(
        `SIM personas: no base cockpit contact ${persona.id}.json in config/sim-contacts/ ` +
        `— the practice cockpit briefing will 404.`
      );
    }

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
      if (GREETING_POOLS[persona.id] && !GREETING_POOLS[persona.id][difficulty]) {
        missing += 1;
        console.warn(
          `SIM personas: greeting pool for ${persona.id} is missing difficulty '${difficulty}'.`
        );
      }
      if (!fs.existsSync(path.join(PROMPT_DIR, `${persona.id}-${difficulty}.txt`))) {
        missing += 1;
        console.warn(
          `SIM personas: no prompt file ${persona.id}-${difficulty}.txt in config/sim-personas/ ` +
          `— getPromptVersion will report 'unknown' and the assistant has no system prompt.`
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
  activePersonaId,
  getPersona,
  _resetCache: () => { cache = null; activePersonaWarned = false; },
};
