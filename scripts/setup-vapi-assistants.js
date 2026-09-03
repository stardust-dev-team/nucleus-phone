#!/usr/bin/env node
/**
 * One-time setup: provision a Twilio phone number, import it into Vapi,
 * and create 3 simulation assistants (easy/medium/hard) for a persona.
 *
 * Usage:
 *   node scripts/setup-vapi-assistants.js [persona]
 *     persona — a persona id from config/sim-personas/personas.json
 *               (default: mike-garza). e.g. `node scripts/setup-vapi-assistants.js ksi-dave`
 *   You can also set SIM_SETUP_PERSONA instead of the positional arg.
 *
 * Requires these env vars (from .env or exported):
 *   VAPI_API_KEY          — shared Vapi account key
 *   TWILIO_ACCOUNT_SID    — Twilio account SID
 *   TWILIO_AUTH_TOKEN      — Twilio auth token
 *
 * Outputs all env vars you need to add to .env / Render. The assistant-id
 * var NAMES come from the persona's `assistantEnvVars` in personas.json
 * (e.g. VAPI_SIM_KSI_EASY_ID for ksi-dave), so they line up with what
 * resolveAssistantId() reads at runtime.
 *
 * The Twilio number is shared across personas — provision it once (mike-garza
 * run), then subsequent persona runs reuse SIM_PHONE_NUMBER / VAPI_PRACTICE_PHONE_ID.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Persona selection (positional arg or SIM_SETUP_PERSONA, default mike-garza).
const PERSONA_ID = process.argv[2] || process.env.SIM_SETUP_PERSONA || 'mike-garza';
const PERSONAS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'sim-personas', 'personas.json'), 'utf-8')
);
const PERSONA = PERSONAS.find((p) => p.id === PERSONA_ID);
if (!PERSONA) {
  console.error(`Unknown persona '${PERSONA_ID}'. Known: ${PERSONAS.map((p) => p.id).join(', ')}`);
  process.exit(1);
}
// Shared greeting source of truth (server/lib/sim-greetings.js) — persona-keyed.
const { pickGreeting } = require('../server/lib/sim-greetings');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WEBHOOK_URL = process.env.VAPI_WEBHOOK_URL || 'https://nucleus-phone.onrender.com/api/sim/webhook';

if (!VAPI_API_KEY || !TWILIO_SID || !TWILIO_TOKEN) {
  console.error('Missing required env vars. Need: VAPI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN');
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

async function twilioApi(method, endpoint, params) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}${endpoint}.json`;
  const opts = {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (params) opts.body = new URLSearchParams(params).toString();

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio ${endpoint} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Known voice ID from ElevenLabs shared library search.
// "Stephen Courson - Hockey Commentator" — male, American, middle-aged, professional/conversational.
const STEPHEN_COURSON_VOICE_ID = 'kpftzLQxRv90Nn6qoJRf';

function getVoiceId() {
  const override = process.env.SIM_ELEVENLABS_VOICE_ID;
  if (override) {
    console.log(`1. Using voice ID from env: ${override}`);
    return override;
  }
  console.log(`1. Using known voice ID: ${STEPHEN_COURSON_VOICE_ID} (Stephen Courson - Hockey Commentator)`);
  return STEPHEN_COURSON_VOICE_ID;
}

async function provisionTwilioNumber() {
  console.log('2. Searching for available Phoenix area code number...');

  // Try 602 first, then 480
  for (const areaCode of ['602', '480']) {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&Limit=1`,
      { headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64') } }
    );
    if (!res.ok) { const t = await res.text(); throw new Error(`Twilio search failed (${res.status}): ${t}`); }
    const available = await res.json();
    if (available.available_phone_numbers?.length > 0) {
      const number = available.available_phone_numbers[0].phone_number;
      console.log(`   Found: ${number} (area code ${areaCode})`);

      console.log('   Provisioning...');
      const purchased = await twilioApi('POST', '/IncomingPhoneNumbers', {
        PhoneNumber: number,
        FriendlyName: 'Nucleus Practice Sim',
      });
      console.log(`   Provisioned: ${purchased.phone_number} (SID: ${purchased.sid})`);
      return { number: purchased.phone_number, sid: purchased.sid };
    }
  }
  throw new Error('No available numbers in 602 or 480 area codes');
}

async function importNumberToVapi(phoneNumber) {
  console.log('3. Importing number into Vapi...');
  const result = await vapiPost('phone-number', {
    provider: 'twilio',
    number: phoneNumber,
    twilioAccountSid: TWILIO_SID,
    twilioAuthToken: TWILIO_TOKEN,
    name: 'Nucleus Practice Sim',
  });
  console.log(`   Vapi phone ID: ${result.id}`);
  return result.id;
}

function loadPrompt(difficulty) {
  const filePath = path.join(__dirname, '..', 'config', 'sim-personas', `${PERSONA_ID}-${difficulty}.txt`);
  return fs.readFileSync(filePath, 'utf-8');
}

async function createAssistant(difficulty, voiceId, webhookSecret) {
  console.log(`   Creating ${difficulty} assistant...`);
  const systemPrompt = loadPrompt(difficulty);

  const result = await vapiPost('assistant', {
    name: `${PERSONA.displayName} (${difficulty})`,
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'system', content: systemPrompt }],
    },
    voice: {
      provider: '11labs',
      voiceId: voiceId,
      stability: 0.7,
      similarityBoost: 0.75,
      style: 0.15,
      useSpeakerBoost: false,
      inputPreprocessingEnabled: false,
    },
    firstMessage: pickGreeting(difficulty, PERSONA_ID),
    backgroundDenoisingEnabled: false,
    backgroundSound: 'off',
    endCallFunctionEnabled: true,
    maxDurationSeconds: 480,
    silenceTimeoutSeconds: 10,
    server: {
      url: WEBHOOK_URL,
      secret: webhookSecret,
    },
  });
  console.log(`   ${difficulty}: ${result.id}`);
  return result.id;
}

// Track created resources for cleanup reporting on failure
const created = { twilioNumber: null, vapiPhoneId: null, assistants: [] };

async function main() {
  console.log('=== Nucleus Phone — Vapi Simulation Setup ===\n');

  // Step 1: ElevenLabs voice ID
  const voiceId = getVoiceId();

  // Step 2: Provision Twilio number (skip if already set)
  let simPhone = process.env.SIM_PHONE_NUMBER;
  let phoneNumberId = process.env.VAPI_PRACTICE_PHONE_ID;

  if (simPhone && phoneNumberId) {
    console.log(`2. Skipping phone provisioning — already set: ${simPhone}`);
    console.log(`3. Skipping Vapi import — already set: ${phoneNumberId}`);
  } else {
    const { number, sid } = await provisionTwilioNumber();
    simPhone = number;
    created.twilioNumber = { number, sid };
    console.log(`   Twilio SID: ${sid} (save this if you need to release the number later)`);
    phoneNumberId = await importNumberToVapi(simPhone);
    created.vapiPhoneId = phoneNumberId;
  }

  // Step 4: Webhook secret (reuse existing or generate new)
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex');
  if (process.env.VAPI_WEBHOOK_SECRET) {
    console.log('\n4. Using existing webhook secret from env');
  } else {
    console.log(`\n4. Generated webhook secret: ${webhookSecret}`);
  }

  // Step 5: Check for existing assistants (this persona's env-var names).
  const EASY_VAR = PERSONA.assistantEnvVars.easy;
  const MEDIUM_VAR = PERSONA.assistantEnvVars.medium;
  const HARD_VAR = PERSONA.assistantEnvVars.hard;
  const existingEasy = process.env[EASY_VAR];
  const existingMedium = process.env[MEDIUM_VAR];
  const existingHard = process.env[HARD_VAR];
  if (existingEasy || existingMedium || existingHard) {
    console.log('\n⚠  WARNING: Existing assistant IDs detected in env:');
    if (existingEasy) console.log(`   ${EASY_VAR}=${existingEasy}`);
    if (existingMedium) console.log(`   ${MEDIUM_VAR}=${existingMedium}`);
    if (existingHard) console.log(`   ${HARD_VAR}=${existingHard}`);
    console.log('   This script will create NEW assistants. Old ones will be orphaned in Vapi.');
    console.log('   Delete old assistants manually via Vapi dashboard or API.\n');
  }

  // Step 6: Create 3 assistants
  console.log(`\n5. Creating Vapi assistants for persona '${PERSONA_ID}' (${PERSONA.displayName})...`);
  const easyId = await createAssistant('easy', voiceId, webhookSecret);
  created.assistants.push({ difficulty: 'easy', id: easyId });
  const mediumId = await createAssistant('medium', voiceId, webhookSecret);
  created.assistants.push({ difficulty: 'medium', id: mediumId });
  const hardId = await createAssistant('hard', voiceId, webhookSecret);
  created.assistants.push({ difficulty: 'hard', id: hardId });

  // Output
  console.log('\n=== Setup Complete ===\n');
  console.log('Add these to .env and Render:\n');
  console.log(`VAPI_WEBHOOK_SECRET=${webhookSecret}`);
  console.log(`${EASY_VAR}=${easyId}`);
  console.log(`${MEDIUM_VAR}=${mediumId}`);
  console.log(`${HARD_VAR}=${hardId}`);
  console.log(`SIM_ELEVENLABS_VOICE_ID=${voiceId}`);
  console.log(`SIM_PHONE_NUMBER=${simPhone}`);
  console.log(`VAPI_PRACTICE_PHONE_ID=${phoneNumberId}`);
  if (PERSONA_ID !== 'mike-garza') {
    console.log(`\n# To make this persona the active practice persona, also set:`);
    console.log(`SIM_ACTIVE_PERSONA=${PERSONA_ID}`);
    console.log(`# (Unset SIM_ACTIVE_PERSONA to revert to mike-garza.)`);
  }
}

main().catch(err => {
  console.error('\n=== Setup FAILED ===');
  console.error('Error:', err.message);
  if (created.twilioNumber || created.vapiPhoneId || created.assistants.length) {
    console.error('\nResources created before failure (clean up manually):');
    if (created.twilioNumber) console.error(`  Twilio number: ${created.twilioNumber.number} (SID: ${created.twilioNumber.sid})`);
    if (created.vapiPhoneId) console.error(`  Vapi phone: ${created.vapiPhoneId}`);
    for (const a of created.assistants) console.error(`  Vapi assistant (${a.difficulty}): ${a.id}`);
  }
  process.exit(1);
});
