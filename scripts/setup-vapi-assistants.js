#!/usr/bin/env node
/**
 * One-time setup: provision a Twilio phone number, import it into Vapi,
 * and create 3 Mike Garza simulation assistants (easy/medium/hard).
 *
 * Usage:
 *   node scripts/setup-vapi-assistants.js
 *
 * Requires these env vars (from .env or exported):
 *   VAPI_API_KEY          — shared Vapi account key
 *   TWILIO_ACCOUNT_SID    — Twilio account SID
 *   TWILIO_AUTH_TOKEN      — Twilio auth token
 *
 * Outputs all env vars you need to add to .env / Render.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

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
  const filePath = path.join(__dirname, '..', 'config', 'sim-personas', `mike-garza-${difficulty}.txt`);
  return fs.readFileSync(filePath, 'utf-8');
}

// Greeting pools — randomized per call so reps don't memorize the opener.
// The system prompt tells Mike NOT to generate a greeting (firstMessage handles it).
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

async function createAssistant(difficulty, voiceId, webhookSecret) {
  console.log(`   Creating ${difficulty} assistant...`);
  const systemPrompt = loadPrompt(difficulty);

  const result = await vapiPost('assistant', {
    name: `Mike Garza (${difficulty})`,
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
    firstMessage: pickGreeting(difficulty),
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

  // Step 5: Check for existing assistants
  const existingEasy = process.env.VAPI_SIM_EASY_ID;
  const existingMedium = process.env.VAPI_SIM_MEDIUM_ID;
  const existingHard = process.env.VAPI_SIM_HARD_ID;
  if (existingEasy || existingMedium || existingHard) {
    console.log('\n⚠  WARNING: Existing assistant IDs detected in env:');
    if (existingEasy) console.log(`   VAPI_SIM_EASY_ID=${existingEasy}`);
    if (existingMedium) console.log(`   VAPI_SIM_MEDIUM_ID=${existingMedium}`);
    if (existingHard) console.log(`   VAPI_SIM_HARD_ID=${existingHard}`);
    console.log('   This script will create NEW assistants. Old ones will be orphaned in Vapi.');
    console.log('   Delete old assistants manually via Vapi dashboard or API.\n');
  }

  // Step 6: Create 3 assistants
  console.log('\n5. Creating Vapi assistants...');
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
  console.log(`VAPI_SIM_EASY_ID=${easyId}`);
  console.log(`VAPI_SIM_MEDIUM_ID=${mediumId}`);
  console.log(`VAPI_SIM_HARD_ID=${hardId}`);
  console.log(`SIM_ELEVENLABS_VOICE_ID=${voiceId}`);
  console.log(`SIM_PHONE_NUMBER=${simPhone}`);
  console.log(`VAPI_PRACTICE_PHONE_ID=${phoneNumberId}`);
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
