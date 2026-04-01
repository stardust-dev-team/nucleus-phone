#!/usr/bin/env node
/**
 * update-vapi-assistants.js — Patch existing Mike Garza assistants
 * with updated firstMessage greeting pools, voice stability, and system prompts.
 *
 * Usage:
 *   node scripts/update-vapi-assistants.js
 *
 * Requires: VAPI_API_KEY, VAPI_SIM_EASY_ID, VAPI_SIM_MEDIUM_ID, VAPI_SIM_HARD_ID
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;

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

  const body = {
    firstMessage: greeting,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: {
      provider: '11labs',
      voiceId: 'wsHauqjSkdBeAvdbUFmR',
    },
    backgroundDenoisingEnabled: false,
    backgroundSound: 'off',
  };

  const res = await fetch(`https://api.vapi.ai/assistant/${id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${difficulty} (${id}) failed (${res.status}): ${text}`);
  }

  return { greeting, status: res.status };
}

async function main() {
  if (!VAPI_API_KEY) {
    console.error('VAPI_API_KEY not set');
    process.exit(1);
  }

  for (const [difficulty, id] of Object.entries(ASSISTANTS)) {
    if (!id) {
      console.warn(`  SKIP ${difficulty} — VAPI_SIM_${difficulty.toUpperCase()}_ID not set`);
      continue;
    }
    try {
      const result = await patchAssistant(id, difficulty);
      console.log(`  OK ${difficulty} (${id}): firstMessage="${result.greeting}"`);
    } catch (err) {
      console.error(`  FAIL ${difficulty}: ${err.message}`);
    }
  }

  console.log('\nDone. Each call will get a random greeting from the pool.');
  console.log('Note: firstMessage is set at assistant level, not per-call.');
  console.log('To randomize per-call, re-run this script or use assistantOverrides.');
}

main();
