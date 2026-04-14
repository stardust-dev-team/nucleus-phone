/**
 * lib/stale-sweep.js — Periodic cleanup of zombie call/sim rows.
 *
 * Runs on an interval to catch rows stuck in transient states
 * (connecting, in-progress, scoring) past a reasonable threshold.
 * Alerts to Slack so Tom knows when the system is misbehaving.
 */

const { pool } = require('../db');
const { sendSystemAlert } = require('./slack');
const { logEvent } = require('./debug-log');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CALL_STALE_MINUTES = 15;
const SIM_STALE_MINUTES = 10;

async function sweepStaleCalls() {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE nucleus_phone_calls
       SET status = 'failed'
       WHERE status IN ('connecting', 'in-progress')
         AND created_at < NOW() - INTERVAL '${CALL_STALE_MINUTES} minutes'
       RETURNING id, caller_identity, status, created_at`
    );

    if (rowCount > 0) {
      console.warn(`stale-sweep: cleaned ${rowCount} stuck call(s)`);
      logEvent('sweep', 'stale-sweep', `cleaned ${rowCount} stuck call(s)`, { detail: { ids: rows.map(r => r.id), callers: rows.map(r => r.caller_identity) } });
      const names = rows.map(r => r.caller_identity).join(', ');
      const ids = rows.map(r => r.id).join(', ');
      sendSystemAlert(
        `⚠️ Stale Call Sweep — cleaned ${rowCount} stuck call(s)`,
        [
          {
            type: 'header',
            text: { type: 'plain_text', text: '⚠️ Stale Call Sweep' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${rowCount} call(s)* stuck in connecting/in-progress for >${CALL_STALE_MINUTES}min were auto-cleaned.\n\n`
                + `*Callers:* ${names}\n*Row IDs:* ${ids}\n\n`
                + `These callers were blocked from starting new calls or practice sessions. They're unblocked now.`,
            },
          },
        ]
      ).catch(err => console.error('stale-sweep: slack alert failed:', err.message));
    }
  } catch (err) {
    console.error('stale-sweep: call sweep failed:', err.message);
  }
}

async function sweepStaleSims() {
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE sim_call_scores
       SET status = 'score-failed'
       WHERE status IN ('in-progress', 'scoring')
         AND created_at < NOW() - INTERVAL '${SIM_STALE_MINUTES} minutes'
       RETURNING id, caller_identity, status, created_at`
    );

    if (rowCount > 0) {
      console.warn(`stale-sweep: cleaned ${rowCount} stuck sim(s)`);
      logEvent('sweep', 'stale-sweep', `cleaned ${rowCount} stuck sim(s)`, { detail: { ids: rows.map(r => r.id), callers: rows.map(r => r.caller_identity) } });
      const names = rows.map(r => r.caller_identity).join(', ');
      const ids = rows.map(r => r.id).join(', ');
      sendSystemAlert(
        `⚠️ Stale Sim Sweep — cleaned ${rowCount} stuck practice call(s)`,
        [
          {
            type: 'header',
            text: { type: 'plain_text', text: '⚠️ Stale Sim Sweep' },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${rowCount} practice call(s)* stuck in progress/scoring for >${SIM_STALE_MINUTES}min were auto-cleaned.\n\n`
                + `*Callers:* ${names}\n*Row IDs:* ${ids}\n\n`
                + `Likely cause: Vapi webhook never fired or scoring timed out.`,
            },
          },
        ]
      ).catch(err => console.error('stale-sweep: slack alert failed:', err.message));
    }
  } catch (err) {
    console.error('stale-sweep: sim sweep failed:', err.message);
  }
}

async function pruneDebugEvents() {
  if (process.env.DEBUG !== '1') return;
  try {
    // Use ts for both ordering and delete predicate — id/ts monotonicity
    // isn't guaranteed (clock skew, manual inserts). Leverages idx_debug_events_ts.
    const { rowCount } = await pool.query(
      `DELETE FROM debug_events WHERE ts < (SELECT ts FROM debug_events ORDER BY ts DESC OFFSET 1000 LIMIT 1)`,
    );
    if (rowCount > 0) console.log(`stale-sweep: pruned ${rowCount} debug event(s)`);
  } catch (err) {
    // OFFSET beyond row count returns no rows — the subquery yields NULL,
    // and the DELETE matches nothing. That's the normal "under 1000" case.
    if (!err.message.includes('does not exist')) {
      console.error('stale-sweep: debug prune failed:', err.message);
    }
  }
}

async function runSweep() {
  await sweepStaleCalls();
  await sweepStaleSims();
  await pruneDebugEvents();
  logEvent('sweep', 'stale-sweep', 'cycle complete');
}

let intervalId;

function startSweep() {
  // Run once immediately to catch anything from a cold start
  runSweep();
  intervalId = setInterval(runSweep, SWEEP_INTERVAL_MS);
  intervalId.unref();
  console.log(`stale-sweep: running every ${SWEEP_INTERVAL_MS / 1000}s`);
}

function stopSweep() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { startSweep, stopSweep, runSweep };
