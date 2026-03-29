#!/usr/bin/env node
/**
 * Validate Vapi webhook payload shape by triggering a brief test call.
 *
 * Creates a temporary assistant, fires a short outbound call, waits for the
 * end-of-call-report webhook, and validates the expected field paths.
 *
 * Usage:
 *   node scripts/test-vapi-webhook.js <phone-number-to-call>
 *
 * Example:
 *   node scripts/test-vapi-webhook.js +16025551234
 *
 * Requires:
 *   VAPI_API_KEY
 *   VAPI_PRACTICE_PHONE_ID  — from setup-vapi-assistants.js
 *
 * The script starts a local HTTP server to capture the webhook payload,
 * so it needs to be run from a machine reachable by Vapi (or use ngrok).
 * Alternatively, pass --dump-only to just fire the call and have the
 * production webhook endpoint capture it.
 */

const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const PHONE_NUMBER_ID = process.env.VAPI_PRACTICE_PHONE_ID;
const TARGET_PHONE = process.argv[2];
const DUMP_ONLY = process.argv.includes('--dump-only');

if (!VAPI_API_KEY) {
  console.error('Missing VAPI_API_KEY');
  process.exit(1);
}
if (!PHONE_NUMBER_ID) {
  console.error('Missing VAPI_PRACTICE_PHONE_ID — run setup-vapi-assistants.js first');
  process.exit(1);
}
if (!TARGET_PHONE) {
  console.error('Usage: node scripts/test-vapi-webhook.js <+1XXXXXXXXXX> [--dump-only]');
  process.exit(1);
}

async function vapiPost(endpoint, body) {
  const res = await fetch(`https://api.vapi.ai/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VAPI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function vapiDelete(endpoint) {
  const res = await fetch(`https://api.vapi.ai/${endpoint}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`Warning: DELETE ${endpoint} returned ${res.status}`);
  }
}

function validatePayload(payload) {
  console.log('\n=== Payload Validation ===\n');
  const { message } = payload;

  const checks = [
    ['message.type', message?.type, 'end-of-call-report'],
    ['message.call.id', message?.call?.id, '(any truthy)'],
    ['message.call.duration', message?.call?.duration, '(number)'],
    ['message.call.cost', message?.call?.cost, '(number or null)'],
    ['message.artifact.transcript', message?.artifact?.transcript, '(any truthy)'],
    ['message.artifact.recordingUrl', message?.artifact?.recordingUrl || message?.artifact?.recording?.url, '(string or null)'],
  ];

  let passed = 0;
  let failed = 0;

  for (const [field, value, expected] of checks) {
    const ok = expected === '(any truthy)'
      ? !!value
      : expected === '(number)'
        ? typeof value === 'number'
        : expected === '(number or null)'
          ? typeof value === 'number' || value === null || value === undefined
          : expected === '(string or null)'
            ? typeof value === 'string' || value === null || value === undefined
            : value === expected;

    const status = ok ? 'PASS' : 'FAIL';
    const icon = ok ? '✓' : '✗';
    console.log(`  ${icon} ${field}: ${JSON.stringify(value)} ${ok ? '' : `(expected: ${expected})`}`);
    if (ok) passed++; else failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);

  // Dump full payload for reference
  console.log('=== Full Payload ===');
  console.log(JSON.stringify(payload, null, 2));

  return failed === 0;
}

async function main() {
  console.log('=== Vapi Webhook Payload Validator ===\n');

  // Create a minimal test assistant
  console.log('1. Creating temporary test assistant...');
  const webhookSecret = 'test-' + Date.now();

  const serverConfig = DUMP_ONLY
    ? {
        url: process.env.VAPI_WEBHOOK_URL || 'https://nucleus-phone.onrender.com/api/sim/webhook',
        secret: process.env.VAPI_WEBHOOK_SECRET || webhookSecret,
      }
    : { url: `http://localhost:9876/webhook`, secret: webhookSecret };

  let captureServer;
  const payloads = [];
  let resolveEndOfCall;
  const endOfCallPromise = new Promise(r => { resolveEndOfCall = r; });

  if (!DUMP_ONLY) {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
          try {
            const payload = JSON.parse(body);
            payloads.push(payload);
            console.log(`   Received: ${payload?.message?.type || 'unknown'}`);
            if (payload?.message?.type === 'end-of-call-report') {
              resolveEndOfCall(payload);
            }
          } catch (e) {
            console.error('Failed to parse webhook body:', e.message);
          }
        });
      } else {
        res.writeHead(200); res.end('ok');
      }
    });
    server.listen(9876, () => {
      console.log('Webhook capture server on port 9876');
      console.log('Note: Vapi must reach this. Use ngrok if needed: ngrok http 9876');
    });
    captureServer = server;
  }

  const assistant = await vapiPost('assistant', {
    name: '_test_webhook_validator',
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: 'You are a test assistant. Say "Hello, this is a test call. Goodbye." and then end the call.' }],
    },
    voice: {
      provider: '11labs',
      voiceId: 'pNInz6obpgDQGcFmaJgB', // Adam — default ElevenLabs voice
      stability: 0.5,
      similarityBoost: 0.5,
    },
    firstMessage: 'Hello, this is a test call. Goodbye.',
    endCallFunctionEnabled: true,
    maxDurationSeconds: 30,
    server: serverConfig,
  });
  console.log(`   Assistant: ${assistant.id}`);

  // Fire test call
  console.log(`\n2. Calling ${TARGET_PHONE}...`);
  const call = await vapiPost('call/phone', {
    assistantId: assistant.id,
    customer: { number: TARGET_PHONE },
    phoneNumberId: PHONE_NUMBER_ID,
  });
  console.log(`   Call: ${call.id}`);

  if (DUMP_ONLY) {
    console.log('\n--dump-only mode: call fired. Check production webhook logs for payload.');
    console.log(`Cleaning up test assistant ${assistant.id} in 60s...`);
    const cleanup = setTimeout(() => {
      vapiDelete(`assistant/${assistant.id}`)
        .then(() => console.log('Test assistant deleted.'))
        .catch(e => console.warn(`Warning: failed to delete test assistant ${assistant.id}: ${e.message}`))
        .finally(() => process.exit(0));
    }, 60000);
    cleanup.ref();
    return;
  }

  // Wait for end-of-call-report webhook
  console.log('\n3. Waiting for end-of-call-report webhook (120s timeout)...');
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Webhook timeout — no end-of-call-report received in 120s')), 120000);
  });

  try {
    const payload = await Promise.race([endOfCallPromise, timeout]);
    const ok = validatePayload(payload);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutId);
    console.log('\n4. Cleaning up test assistant...');
    await vapiDelete(`assistant/${assistant.id}`);
    captureServer?.close();
    console.log('   Done.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
