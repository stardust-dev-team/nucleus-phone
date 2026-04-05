#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
/**
 * One-time batch: resolve truncated last names (e.g., "Ashley P.") via Apollo People Match.
 * LinkedIn Sales Navigator abbreviates non-connected contacts. Apollo returns full names.
 *
 * Usage: node scripts/resolve-truncated-names.js [--dry-run] [--limit N]
 */

const { pool } = require('../server/db');
const { matchPerson } = require('../server/lib/apollo');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--limit') || '250', 10);
const DELAY_MS = 500; // Apollo rate limit: ~2 req/s

async function main() {
  console.log(`Resolving truncated names (dry_run=${DRY_RUN}, limit=${LIMIT})`);

  const { rows } = await pool.query(`
    SELECT id, full_name, first_name, last_name, title, company_name, phone, email
    FROM v35_pb_contacts
    WHERE last_name ~ '^\\w\\.$'
    ORDER BY phone IS NOT NULL DESC, id
    LIMIT $1
  `, [LIMIT]);

  console.log(`Found ${rows.length} contacts with truncated last names`);

  let resolved = 0, failed = 0, skipped = 0;

  for (const row of rows) {
    const { id, first_name, company_name, email, phone } = row;

    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${row.full_name} at ${company_name}`);
        skipped++;
        continue;
      }

      const person = await matchPerson({
        firstName: first_name,
        organization: company_name,
        email: email || undefined,
      });

      if (person?.first_name && person?.last_name && !/^\w\.$/.test(person.last_name)) {
        const fullName = `${person.first_name} ${person.last_name}`;
        await pool.query(`
          UPDATE v35_pb_contacts
          SET full_name = $1, first_name = $2, last_name = $3,
              email = COALESCE(email, $4)
          WHERE id = $5
        `, [fullName, person.first_name, person.last_name, person.email || null, id]);

        console.log(`  ✓ ${row.full_name} → ${fullName} at ${company_name}`);
        resolved++;
      } else {
        console.log(`  ✗ ${row.full_name} at ${company_name} — Apollo returned no match or still truncated`);
        failed++;
      }

      await new Promise(r => setTimeout(r, DELAY_MS));
    } catch (err) {
      console.error(`  ✗ ${row.full_name} at ${company_name} — ${err.message}`);
      failed++;
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone: ${resolved} resolved, ${failed} failed, ${skipped} skipped`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
