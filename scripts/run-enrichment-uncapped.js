#!/usr/bin/env node
/**
 * scripts/run-enrichment-uncapped.js
 *
 * Contact enrichment for signal-scored companies. Finds callable people
 * (with phone numbers) at Spear/Targeted companies via Apollo People Search.
 *
 * Credit model:
 *   - Search (free): finds anonymized contact previews at a domain
 *   - Reveal with phone (8 credits): gets full name, email, phone, LinkedIn
 *   - Only reveals contacts flagged has_direct_phone === "Yes"
 *   - Credits are tracked in shared v35_credit_daily_ledger
 *
 * Usage: node scripts/run-enrichment-uncapped.js [--dry-run] [--limit N] [--credit-cap N]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { Pool } = require('pg');
const { searchPeopleByCompany } = require('../server/lib/apollo');
const { normalizeCompanyName } = require('../server/lib/company-normalizer');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

const APOLLO_DAILY_BUDGET = 50;

async function incrementLedger(credits) {
  if (credits <= 0) return;
  await pool.query(
    `INSERT INTO v35_credit_daily_ledger (ledger_date, service, budget_limit, consumed, last_increment_at)
     VALUES (CURRENT_DATE, 'apollo', $1, $2, NOW())
     ON CONFLICT (ledger_date, service) DO UPDATE SET
       consumed = v35_credit_daily_ledger.consumed + $2,
       last_increment_at = NOW()`,
    [APOLLO_DAILY_BUDGET, credits],
  );
}

async function checkLedger() {
  const { rows } = await pool.query(
    `SELECT consumed, remaining FROM v35_credit_daily_ledger
     WHERE ledger_date = CURRENT_DATE AND service = 'apollo'`,
  );
  if (!rows.length) return { consumed: 0, remaining: APOLLO_DAILY_BUDGET };
  return { consumed: parseInt(rows[0].consumed), remaining: parseInt(rows[0].remaining) };
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 500;
})();
const CREDIT_CAP = (() => {
  const idx = process.argv.indexOf('--credit-cap');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : APOLLO_DAILY_BUDGET;
})();

async function upsertContact(contact, company, batchId) {
  const norm = normalizeCompanyName(company.company_name);

  // Handle both unique constraints: linkedin URL and (domain, email)
  // Use two-step: try insert, on conflict update
  try {
    await pool.query(
      `INSERT INTO v35_pb_contacts
         (full_name, first_name, last_name, title, company_name, company_name_norm,
          linkedin_profile_url, email, phone, domain, source, enrichment_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'apollo', $11)
       ON CONFLICT (domain, email)
         WHERE source = 'apollo' AND email IS NOT NULL
       DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, v35_pb_contacts.phone),
         title = COALESCE(EXCLUDED.title, v35_pb_contacts.title),
         full_name = COALESCE(EXCLUDED.full_name, v35_pb_contacts.full_name),
         linkedin_profile_url = COALESCE(EXCLUDED.linkedin_profile_url, v35_pb_contacts.linkedin_profile_url)`,
      [
        contact.name, contact.first_name, contact.last_name, contact.title,
        company.company_name, norm,
        contact.linkedin_url, contact.email, contact.phone, company.domain, batchId,
      ],
    );
    return true;
  } catch (err) {
    if (err.message.includes('idx_pbc_linkedin_unique')) {
      // LinkedIn URL already exists for a different company — update the existing row
      await pool.query(
        `UPDATE v35_pb_contacts SET
           phone = COALESCE($1, phone), title = COALESCE($2, title),
           email = COALESCE($3, email), domain = COALESCE($4, domain)
         WHERE linkedin_profile_url = $5`,
        [contact.phone, contact.title, contact.email, company.domain, contact.linkedin_url],
      );
      return true;
    }
    console.error(`    DB error for ${contact.name}: ${err.message}`);
    return false;
  }
}

async function run() {
  const batchId = `spear-targeted-${new Date().toISOString().slice(0, 10)}`;

  console.log(`\n=== Signal Contact Enrichment ===`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Credit cap: ${CREDIT_CAP}`);
  console.log(`Batch:      ${batchId}`);
  console.log(`Apollo key: ${process.env.APOLLO_API_KEY ? 'set' : 'MISSING'}\n`);

  if (!process.env.APOLLO_API_KEY) {
    console.error('APOLLO_API_KEY not set');
    process.exit(1);
  }

  // Spear first, then Targeted — ordered by signal_score within each tier
  const { rows: companies } = await pool.query(
    `SELECT sm.domain, lr.company_name, sm.signal_tier, sm.signal_score
     FROM v35_signal_metadata sm
     JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
     WHERE sm.signal_tier IN ('spear', 'targeted')
       AND sm.domain NOT LIKE '%.signal-pending'
       AND NOT EXISTS (
         SELECT 1 FROM v35_pb_contacts pb
         WHERE pb.domain = sm.domain AND pb.source = 'apollo'
       )
     ORDER BY
       CASE sm.signal_tier WHEN 'spear' THEN 0 WHEN 'targeted' THEN 1 ELSE 2 END,
       sm.signal_score DESC
     LIMIT $1`,
    [LIMIT],
  );

  console.log(`Companies to enrich: ${companies.length}`);
  const spearCount = companies.filter(c => c.signal_tier === 'spear').length;
  const targetedCount = companies.filter(c => c.signal_tier === 'targeted').length;
  console.log(`  Spear: ${spearCount}  Targeted: ${targetedCount}\n`);

  if (!companies.length) {
    console.log('Nothing to enrich.');
    await pool.end();
    return;
  }

  let totalContacts = 0;
  let totalCredits = 0;
  let companiesProcessed = 0;
  let companiesWithContacts = 0;
  let noResults = 0;
  let errors = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const tier = c.signal_tier.toUpperCase().padEnd(8);

    // Hard credit cap check
    if (totalCredits >= CREDIT_CAP) {
      console.log(`\n⛔ Credit cap reached (${totalCredits}/${CREDIT_CAP}). Stopping.`);
      break;
    }

    // Shared ledger budget check
    if (!DRY_RUN) {
      const ledger = await checkLedger();
      if (ledger.remaining <= 0) {
        console.log(`\n⛔ Shared daily budget exhausted (${ledger.consumed} consumed). Stopping.`);
        break;
      }
    }

    try {
      if (DRY_RUN) {
        console.log(`  [${i + 1}/${companies.length}] [${tier}] Would enrich: ${c.company_name} (${c.domain})`);
        companiesProcessed++;
        continue;
      }

      const result = await searchPeopleByCompany(c.domain);
      const { previews, contacts, creditsUsed } = result;

      if (contacts.length === 0) {
        console.log(`  [${i + 1}/${companies.length}] [${tier}] ○ ${c.company_name} — ${previews.length} previews, 0 with phone`);
        noResults++;
      } else {
        let stored = 0;
        for (const contact of contacts) {
          if (!contact.email && !contact.linkedin_url) continue;
          const ok = await upsertContact(contact, c, batchId);
          if (ok) stored++;
        }

        console.log(`  [${i + 1}/${companies.length}] [${tier}] ✓ ${c.company_name} — ${stored} contacts stored (${creditsUsed} credits)`);
        totalContacts += stored;
        companiesWithContacts++;
      }

      totalCredits += creditsUsed;
      if (creditsUsed > 0) await incrementLedger(creditsUsed);
      companiesProcessed++;

      // Progress checkpoint every 25 companies
      if (companiesProcessed % 25 === 0) {
        console.log(`  --- checkpoint: ${companiesProcessed} companies, ${totalContacts} contacts, ${totalCredits} credits ---`);
      }

      // Rate limit: 1 req/sec
      if (i < companies.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      if (err.message.includes('insufficient credits')) {
        console.error(`\n⛔ Apollo account credits exhausted after ${totalCredits} credits used.`);
        break;
      }
      console.error(`  [${i + 1}/${companies.length}] [${tier}] ! ${c.company_name} — ${err.message}`);
      errors++;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`ENRICHMENT COMPLETE`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Companies processed:      ${companiesProcessed}`);
  console.log(`Companies with contacts:  ${companiesWithContacts}`);
  console.log(`Companies without:        ${noResults}`);
  console.log(`Total contacts stored:    ${totalContacts}`);
  console.log(`Apollo credits consumed:  ${totalCredits}`);
  console.log(`Errors:                   ${errors}`);
  console.log(`Credit cap:               ${CREDIT_CAP}`);
  console.log(`${'='.repeat(50)}`);

  if (DRY_RUN) console.log(`\nDry run — no changes applied.`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
