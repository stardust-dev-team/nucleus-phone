#!/usr/bin/env node
/**
 * scripts/run-enrichment-uncapped.js
 *
 * CLI wrapper around the shared enrichment lib. Claims a job slot via
 * claimEnrichmentSlot() (pg advisory lock) so this script and the API
 * route cannot run concurrently — preventing duplicate enrichment.
 *
 * Usage: node scripts/run-enrichment-uncapped.js [--dry-run] [--limit N] [--credit-cap N]
 */

require('dotenv').config();
require('dotenv').config({ path: '/Users/Shared/joruva-v35-scripts/.env', override: false });

const { pool } = require('../server/db');
const { runBatchEnrichment, claimEnrichmentSlot, APOLLO_DAILY_BUDGET } = require('../server/lib/signal-enrichment');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 500;
})();
const CREDIT_CAP = (() => {
  const idx = process.argv.indexOf('--credit-cap');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : APOLLO_DAILY_BUDGET;
})();

async function run() {
  console.log(`\n=== Signal Contact Enrichment (CLI) ===`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Credit cap: ${CREDIT_CAP}`);
  console.log(`Limit:      ${LIMIT}`);
  console.log(`Apollo key: ${process.env.APOLLO_API_KEY ? 'set' : 'MISSING'}\n`);

  if (!process.env.APOLLO_API_KEY) {
    console.error('APOLLO_API_KEY not set');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('Dry run — skipping slot claim, no API calls will be made.');
    // Dry run still queries for companies but doesn't call Apollo or write.
    // We can't use runBatchEnrichment for dry-run since it always writes.
    // Just report what would be enriched.
    const { rows } = await pool.query(
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

    console.log(`Would enrich ${rows.length} companies:`);
    const spear = rows.filter(r => r.signal_tier === 'spear').length;
    const targeted = rows.filter(r => r.signal_tier === 'targeted').length;
    console.log(`  Spear: ${spear}  Targeted: ${targeted}`);
    rows.forEach((r, i) => {
      console.log(`  [${i + 1}] [${r.signal_tier.toUpperCase().padEnd(8)}] ${r.company_name} (${r.domain})`);
    });
    console.log('\nDry run — no changes applied.');
    await pool.end();
    return;
  }

  // Claim exclusive slot — throws {code: 'CONCURRENT_JOB'} if another run is active
  let jobId;
  try {
    jobId = await claimEnrichmentSlot(['spear', 'targeted']);
  } catch (err) {
    if (err.code === 'CONCURRENT_JOB') {
      console.error('Another enrichment job is already running. Exiting.');
      await pool.end();
      process.exit(1);
    }
    throw err;
  }

  console.log(`Job claimed: ${jobId}\n`);

  const result = await runBatchEnrichment({
    tiers: ['spear', 'targeted'],
    jobId,
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`ENRICHMENT COMPLETE`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Status:              ${result.status}`);
  console.log(`Companies processed: ${result.processed}`);
  console.log(`Credits consumed:    ${result.creditsUsed}`);
  console.log(`${'='.repeat(50)}`);

  await pool.end();
}

run().catch(async (err) => {
  console.error('Fatal:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
