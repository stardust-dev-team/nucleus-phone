#!/usr/bin/env node

/**
 * configure-inbound.js — Sets the Twilio phone number's Voice URL
 * to the incoming call handler so inbound calls get forwarded.
 *
 * Usage: node scripts/configure-inbound.js
 *
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, NUCLEUS_PHONE_NUMBER_SID, APP_URL in env.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { client } = require('../server/lib/twilio');

const phoneNumberSid = process.env.NUCLEUS_PHONE_NUMBER_SID;
const appUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
const voiceUrl = `${appUrl}/api/voice/incoming`;

if (!phoneNumberSid) {
  console.error('NUCLEUS_PHONE_NUMBER_SID not set in env');
  process.exit(1);
}

async function main() {
  console.log(`Configuring inbound voice URL for ${phoneNumberSid}...`);
  console.log(`  Voice URL: ${voiceUrl}`);

  const number = await client.incomingPhoneNumbers(phoneNumberSid).update({
    voiceUrl,
    voiceMethod: 'POST',
    voiceFallbackUrl: `${appUrl}/api/voice/incoming/fallback`,
    voiceFallbackMethod: 'POST',
  });

  console.log(`\nDone. Phone number ${number.phoneNumber} now forwards inbound calls.`);
  console.log(`  SID: ${number.sid}`);
  console.log(`  Voice URL: ${number.voiceUrl}`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
