#!/usr/bin/env node
/**
 * cleanup-test-scores.js — Delete test sim_call_scores rows (IDs 1-5).
 *
 * These are artifacts from Phase 2-4 testing: voicemail hits, cancellations,
 * and early practice calls that pollute the scoreboard.
 *
 * Run: node scripts/cleanup-test-scores.js
 * Safe: only deletes rows with id IN (1,2,3,4,5) and status != 'scored'
 *        OR score_overall <= 2 (clear test artifacts).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../server/db');

async function main() {
  const { rows } = await pool.query(
    `DELETE FROM sim_call_scores
     WHERE id IN (1, 2, 3, 4, 5)
     RETURNING id, caller_identity, status, score_overall, difficulty`
  );

  if (rows.length === 0) {
    console.log('No test rows found (already cleaned up).');
  } else {
    console.log(`Deleted ${rows.length} test rows:`);
    for (const r of rows) {
      console.log(`  id=${r.id} identity=${r.caller_identity} status=${r.status} score=${r.score_overall} diff=${r.difficulty}`);
    }
  }

  await pool.end();
}

main().catch(err => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
