#!/usr/bin/env node

/**
 * update-vapi-server-messages.js — PATCH Mike Garza assistants with serverMessages config.
 *
 * Configures each practice call assistant to send transcript events to the
 * sim webhook in real time, enabling live equipment analysis during practice calls.
 *
 * Usage: node scripts/update-vapi-server-messages.js
 *
 * Requires: VAPI_API_KEY, VAPI_WEBHOOK_SECRET in .env (or environment).
 */

require('dotenv').config();

const VAPI_BASE = 'https://api.vapi.ai';

const ASSISTANTS = {
  easy:   process.env.VAPI_SIM_EASY_ID,
  medium: process.env.VAPI_SIM_MEDIUM_ID,
  hard:   process.env.VAPI_SIM_HARD_ID,
};

const SERVER_URL = (process.env.APP_URL || 'https://nucleus-phone.onrender.com') + '/api/sim/webhook';

async function patchAssistant(name, id) {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) throw new Error('VAPI_API_KEY not set');
  if (!id) {
    console.warn(`  SKIP ${name}: no assistant ID configured`);
    return;
  }

  const secret = process.env.VAPI_WEBHOOK_SECRET;
  const body = {
    server: {
      url: SERVER_URL,
      ...(secret && { secret }),
    },
    serverMessages: ['transcript', 'end-of-call-report'],
  };

  const res = await fetch(`${VAPI_BASE}/assistant/${id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${name} (${id}) failed (${res.status}): ${text.substring(0, 300)}`);
  }

  const data = await res.json();
  const url = data.server?.url || data.serverUrl;
  console.log(`  ✓ ${name} (${id}): serverUrl=${url}, serverMessages=[${data.serverMessages?.join(', ')}]`);
}

async function main() {
  console.log('Updating Vapi assistant serverMessages config...');
  console.log(`  serverUrl: ${SERVER_URL}`);
  console.log();

  for (const [name, id] of Object.entries(ASSISTANTS)) {
    await patchAssistant(name, id);
  }

  console.log('\nDone. Fire a test practice call to verify transcript events arrive.');
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
