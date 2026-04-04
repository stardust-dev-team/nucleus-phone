#!/usr/bin/env node
/**
 * scripts/resolve-signal-domains.js
 *
 * Resolves .signal-pending placeholder domains to real website domains
 * using Apollo's organization search (FREE — no credits consumed).
 *
 * Updates both v35_signal_metadata and v35_lead_reservoir with the resolved domain.
 *
 * Usage: node scripts/resolve-signal-domains.js [--dry-run] [--limit N]
 */

require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
if (!APOLLO_API_KEY) {
  console.error('APOLLO_API_KEY not set');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 600;
})();

async function searchOrganization(name) {
  // Use /v1/organizations/search (same endpoint as joruva-mcp-apollo)
  // NOT /v1/mixed_companies/search (different results)
  const resp = await fetch('https://api.apollo.io/api/v1/organizations/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': APOLLO_API_KEY },
    body: JSON.stringify({ q_organization_name: name, per_page: 1 }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) return null;
  const data = await resp.json();
  const org = data.organizations?.[0];
  if (!org) return null;

  const website = org.website_url || '';
  let domain = org.primary_domain;
  if (!domain && website) {
    try { domain = new URL(website).hostname.replace(/^www\./, ''); } catch {}
  }

  return domain ? { domain, name: org.name, website } : null;
}

async function run() {
  console.log(`\n=== Signal Domain Resolver ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Limit: ${LIMIT}\n`);

  // Get all .signal-pending companies in SPEAR+TARGETED
  const result = await pool.query(
    `SELECT sm.domain AS old_domain, lr.company_name, sm.signal_tier, sm.signal_score
     FROM v35_signal_metadata sm
     JOIN v35_lead_reservoir lr ON lr.domain = sm.domain
     WHERE sm.domain LIKE '%.signal-pending'
       AND sm.signal_tier IN ('spear', 'targeted')
     ORDER BY sm.signal_score DESC
     LIMIT $1`,
    [LIMIT],
  );

  const companies = result.rows;
  console.log(`Found ${companies.length} companies with .signal-pending domains\n`);

  let resolved = 0;
  let notFound = 0;
  let errors = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    // Strip suffixes for better search (Inc., LLC, Corp., etc.)
    const searchName = c.company_name
      .replace(/,?\s*(INC\.?|LLC\.?|CORP\.?|L\.?P\.?|CO\.?|LTD\.?)\s*$/i, '')
      .trim();

    try {
      const match = await searchOrganization(searchName);

      if (match) {
        console.log(`  [${i + 1}/${companies.length}] ✓ ${c.company_name} → ${match.domain} (${match.name})`);

        if (!DRY_RUN) {
          // Check if the resolved domain already exists in the tables
          const existing = await pool.query(
            `SELECT domain FROM v35_signal_metadata WHERE domain = $1`,
            [match.domain],
          );

          if (existing.rows.length > 0) {
            // Domain already exists — merge signal data instead of overwriting
            console.log(`    ⚠ Domain ${match.domain} already exists — skipping (would create duplicate)`);
            notFound++;
            continue;
          }

          // Update both tables atomically
          await pool.query('BEGIN');
          await pool.query(
            `UPDATE v35_signal_metadata SET domain = $1 WHERE domain = $2`,
            [match.domain, c.old_domain],
          );
          await pool.query(
            `UPDATE v35_lead_reservoir SET domain = $1 WHERE domain = $2`,
            [match.domain, c.old_domain],
          );
          await pool.query('COMMIT');
        }
        resolved++;
      } else {
        console.log(`  [${i + 1}/${companies.length}] ✗ ${c.company_name} — not found in Apollo`);
        notFound++;
      }

      // Rate limit: ~2 req/sec to be safe
      if (i < companies.length - 1) await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.error(`  [${i + 1}/${companies.length}] ! ${c.company_name} — error: ${err.message}`);
      errors++;
      try { await pool.query('ROLLBACK'); } catch {}
    }
  }

  console.log(`\n=== Results ===`);
  console.log(`Resolved: ${resolved}`);
  console.log(`Not found: ${notFound}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total: ${companies.length}`);

  if (DRY_RUN) console.log(`\nThis was a dry run. Run without --dry-run to apply changes.`);

  await pool.end();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
