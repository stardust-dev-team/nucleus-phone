#!/usr/bin/env node
/**
 * scripts/backfill-apollo-phones.js
 *
 * Re-match Apollo contacts to backfill apollo_person_id (and optionally phone).
 *
 * Default mode (no --with-phone): calls /people/match by email without
 * reveal_phone_number. Gets apollo_person_id for free (cached reveal).
 * Phone numbers won't be returned synchronously — they require webhook delivery.
 *
 * With --with-phone: also sends reveal_phone_number=true + webhook_url.
 * Costs 8 credits per contact. Phone is delivered async via webhook.
 *
 * Usage: node scripts/backfill-apollo-phones.js [--dry-run] [--limit N] [--with-phone]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const WEBHOOK_URL = process.env.APOLLO_PHONE_WEBHOOK_URL
  || 'https://nucleus-phone.onrender.com/api/apollo/phone-webhook';
const DRY_RUN = process.argv.includes('--dry-run');
const WITH_PHONE = process.argv.includes('--with-phone');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 600;
})();

/**
 * Extract a direct/mobile phone from Apollo's phone_numbers array.
 * sanitized_phone on the person object is always the org's main line — never use it.
 */
function pickDirectPhone(phoneNumbers) {
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) return null;
  const direct = phoneNumbers.find(p =>
    (p.type_cd === 'mobile' || p.type_cd === 'direct' || p.type === 'mobile' || p.type === 'direct')
    && p.status_cd !== 'invalid_number',
  );
  return direct?.sanitized_number || null;
}

async function matchByEmail(email) {
  const body = { email };
  if (WITH_PHONE) {
    body.reveal_phone_number = true;
    body.webhook_url = WEBHOOK_URL;
  }

  const resp = await fetch('https://api.apollo.io/api/v1/people/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const p = data.person;
  if (!p) return null;

  return {
    apollo_person_id: p.id || null,
    phone: pickDirectPhone(p.phone_numbers),
  };
}

async function run() {
  console.log(`\n=== Apollo Contact Backfill ===`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Phone:      ${WITH_PHONE ? 'YES (8 credits each, async webhook)' : 'NO (ID backfill only, free)'}`);
  console.log(`Limit:      ${LIMIT}`);
  if (WITH_PHONE) console.log(`Webhook:    ${WEBHOOK_URL}`);
  console.log();

  // Backfill contacts missing apollo_person_id (or missing phone if --with-phone)
  // Static strings only — not derived from user input
  const whereClause = WITH_PHONE
    ? `source = 'apollo' AND phone IS NULL AND email IS NOT NULL`
    : `source = 'apollo' AND apollo_person_id IS NULL AND email IS NOT NULL`;

  const { rows: contacts } = await pool.query(
    `SELECT id, full_name, email, company_name, domain
     FROM v35_pb_contacts
     WHERE ${whereClause}
     ORDER BY id
     LIMIT $1`,
    [LIMIT],
  );

  console.log(`${contacts.length} contacts to process\n`);
  if (!contacts.length) { await pool.end(); return; }

  let idBackfilled = 0, phoneFound = 0, missed = 0, errors = 0;

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    try {
      if (DRY_RUN) {
        console.log(`  [${i + 1}/${contacts.length}] Would re-match: ${c.full_name} (${c.email})`);
        continue;
      }

      const result = await matchByEmail(c.email);

      if (!result) {
        console.log(`  [${i + 1}/${contacts.length}] ○ ${c.full_name} — not found in Apollo`);
        missed++;
        continue;
      }

      // Always store apollo_person_id if we got one
      const updates = [];
      const values = [];
      let paramIdx = 1;

      if (result.apollo_person_id) {
        updates.push(`apollo_person_id = $${paramIdx++}`);
        values.push(result.apollo_person_id);
        idBackfilled++;
      }

      if (result.phone) {
        updates.push(`phone = $${paramIdx++}`);
        values.push(result.phone);
        phoneFound++;
      }

      if (updates.length > 0) {
        values.push(c.id);
        await pool.query(
          `UPDATE v35_pb_contacts SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
          values,
        );
        const parts = [];
        if (result.apollo_person_id) parts.push(`id=${result.apollo_person_id.substring(0, 8)}…`);
        if (result.phone) parts.push(`phone=${result.phone}`);
        console.log(`  [${i + 1}/${contacts.length}] ✓ ${c.full_name} → ${parts.join(', ')}`);
      } else {
        console.log(`  [${i + 1}/${contacts.length}] ○ ${c.full_name} — no new data`);
        missed++;
      }

      // Rate limit
      if (i < contacts.length - 1) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`  [${i + 1}/${contacts.length}] ! ${c.full_name} — ${err.message}`);
      errors++;
      if (err.message.includes('insufficient credits')) {
        console.error('\n⛔ Apollo credits exhausted.');
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`IDs backfilled: ${idBackfilled}`);
  console.log(`Phones found:   ${phoneFound}${WITH_PHONE ? ' (sync) + async via webhook' : ''}`);
  console.log(`No data:        ${missed}`);
  console.log(`Errors:         ${errors}`);
  console.log(`Total:          ${contacts.length}`);

  await pool.end();
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
