#!/usr/bin/env node
/**
 * update-vapi-assistants.js — Patch existing Mike Garza assistants
 * with updated firstMessage greeting pools, voice stability, and system prompts.
 *
 * Usage:
 *   node scripts/update-vapi-assistants.js
 *
 * Requires: VAPI_API_KEY, VAPI_SIM_EASY_ID, VAPI_SIM_MEDIUM_ID, VAPI_SIM_HARD_ID
 *
 * Exits nonzero if any PATCH fails, if no IDs are configured, or if a fetched
 * voice config is missing required fields.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const FETCH_TIMEOUT_MS = 15000;

const ASSISTANTS = {
  easy:   process.env.VAPI_SIM_EASY_ID,
  medium: process.env.VAPI_SIM_MEDIUM_ID,
  hard:   process.env.VAPI_SIM_HARD_ID,
};

const GREETING_POOLS = {
  easy: [
    "Garza Precision, this is Mike. What can I do for you?",
    "Hey, Mike Garza.",
    "This is Mike at Garza Precision, how can I help you?",
    "Garza Precision, Mike speaking.",
  ],
  medium: [
    "Yeah, this is Mike.",
    "Mike speaking.",
    "Garza Precision.",
    "This is Mike.",
  ],
  hard: [
    "Garza Precision.",
    "Yeah.",
    "Mike.",
    "Hello???",
  ],
};

// Fields whose absence caused the 2026-04-13 incident. If a GET returns a voice
// block missing any of these, refuse to PATCH — round-tripping a degraded config
// would wipe the field on Vapi's end. See memory/runbooks/vapi-pronunciation.md #8.
const REQUIRED_VOICE_FIELDS = ['voiceId', 'stability', 'similarityBoost'];

function pickGreeting(difficulty) {
  const pool = GREETING_POOLS[difficulty];
  return pool[Math.floor(Math.random() * pool.length)];
}

function loadPrompt(difficulty) {
  const filePath = path.join(__dirname, '..', 'config', 'sim-personas', `mike-garza-${difficulty}.txt`);
  return fs.readFileSync(filePath, 'utf-8');
}

async function patchAssistant(id, difficulty) {
  const systemPrompt = loadPrompt(difficulty);
  const greeting = pickGreeting(difficulty);

  // Vapi PATCH REPLACES the entire `voice` object (not deep merge). Fetch current
  // voice and pass it through unchanged to preserve stability/similarityBoost/
  // style/useSpeakerBoost/inputPreprocessingEnabled/pronunciationDictionaryLocators.
  // See memory/runbooks/vapi-pronunciation.md gotcha #8 (incident 2026-04-13).
  //
  // Known race: another writer (Vapi dashboard, parallel script) could update the
  // assistant between GET and PATCH; we'd overwrite their change. Vapi returns
  // weak ETags (W/"...") which are invalid for If-Match per RFC 7232, so
  // optimistic concurrency isn't trivially safe to bolt on. Acceptable for
  // manual-deploy use; revisit if this script ever runs unattended.
  const getRes = await fetch(`https://api.vapi.ai/assistant/${id}`, {
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!getRes.ok) {
    throw new Error(`GET ${difficulty} (${id}) failed (${getRes.status}): ${await getRes.text()}`);
  }
  const current = await getRes.json();
  const missing = REQUIRED_VOICE_FIELDS.filter(k => current.voice?.[k] === undefined);
  if (missing.length) {
    throw new Error(
      `GET ${difficulty} (${id}) voice missing required fields: ${missing.join(', ')} — refusing to PATCH (would wipe them)`
    );
  }

  const body = {
    firstMessage: greeting,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: current.voice,
    backgroundDenoisingEnabled: true,
    backgroundSound: 'off',
  };

  const res = await fetch(`https://api.vapi.ai/assistant/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`PATCH ${difficulty} (${id}) failed (${res.status}): ${await res.text()}`);
  }

  return { greeting, status: res.status };
}

async function main() {
  if (!VAPI_API_KEY) {
    console.error('VAPI_API_KEY not set');
    process.exit(1);
  }

  const entries = Object.entries(ASSISTANTS);
  const configured = entries.filter(([, id]) => id);
  const skipped = entries.filter(([, id]) => !id).map(([d]) => d);

  for (const d of skipped) {
    console.warn(`  SKIP ${d} — VAPI_SIM_${d.toUpperCase()}_ID not set`);
  }

  if (configured.length === 0) {
    console.error('No assistant IDs configured — nothing to do.');
    process.exit(1);
  }

  const results = await Promise.allSettled(
    configured.map(([difficulty, id]) => patchAssistant(id, difficulty))
  );

  let failures = 0;
  results.forEach((r, i) => {
    const [difficulty, id] = configured[i];
    if (r.status === 'fulfilled') {
      console.log(`  OK ${difficulty} (${id}): firstMessage="${r.value.greeting}"`);
    } else {
      failures++;
      console.error(`  FAIL ${difficulty} (${id}): ${r.reason.message}`);
    }
  });

  console.log(`\nDone. ${results.length - failures}/${results.length} assistants updated.`);
  console.log('Note: firstMessage is baked in at script-run time, not per-call.');
  console.log('Re-run to randomize, or use assistantOverrides at call-creation time.');

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
