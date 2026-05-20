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
// Two-tier sim sweep (B2b):
//   - TIER 1: vapi_call_id IS NULL  → iOS never connected (or Vapi was never
//     dialed because of a bridge failure). Fail fast at 10 min.
//   - TIER 2: vapi_call_id IS NOT NULL → Vapi connected but the
//     end-of-call-report webhook never arrived. Longer threshold gives the
//     happy-path scoring pipeline time to run before we steal the row.
//     Admin can rescore later via /api/sim/call/:id/rescore once
//     transcripts surface.
//   - 'scoring' status retains the 10-min threshold (scoring should never
//     take this long; if it does, something is wedged).
const SIM_TIER1_MINUTES = 10;
const SIM_TIER2_MINUTES = 20;
const SIM_SCORING_STALE_MINUTES = 10;

async function sweepStaleCalls() {
  try {
    // Interval values are parameterized (not template-interpolated) so
    // env-driven thresholds in the future can't smuggle injection through
    // here. Postgres's `make_interval(mins => $N)` is the canonical
    // recipe for parameterized intervals.
    const { rows, rowCount } = await pool.query(
      `UPDATE nucleus_phone_calls
       SET status = 'failed'
       WHERE status IN ('connecting', 'in-progress')
         AND created_at < NOW() - make_interval(mins => $1)
       RETURNING id, caller_identity, status, created_at`,
      [CALL_STALE_MINUTES]
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
    // Single UPDATE with three OR'd predicates so the sweep is atomic
    // (no read-then-write races) and produces one RETURNING set we can
    // partition for the alert. The CASE expression tags each swept row
    // with the tier that matched (COALESCE preserves existing
    // caller_debrief from explicit failure paths like the sim-bridge).
    // The WHERE clause is exhaustive across these three branches, so the
    // CASE has no ELSE — a future predicate addition without a CASE
    // branch will land NULL into COALESCE and inherit caller_debrief,
    // which is visible in operations and shows up as a clear "we forgot
    // to tag this tier" signal.
    const { rows, rowCount } = await pool.query(
      `UPDATE sim_call_scores
       SET status = 'score-failed',
           caller_debrief = COALESCE(caller_debrief, CASE
             WHEN vapi_call_id IS NULL  AND status = 'in-progress'
                  THEN 'timeout: iOS never connected or Vapi bridge failed'
             WHEN vapi_call_id IS NOT NULL AND status = 'in-progress'
                  THEN 'timeout: Vapi end-of-call webhook never arrived'
             WHEN status = 'scoring'
                  THEN 'timeout: scoring pipeline wedged'
           END)
       WHERE (status = 'in-progress' AND vapi_call_id IS NULL
              AND created_at < NOW() - make_interval(mins => $1))
          OR (status = 'in-progress' AND vapi_call_id IS NOT NULL
              AND created_at < NOW() - make_interval(mins => $2))
          OR (status = 'scoring'
              AND created_at < NOW() - make_interval(mins => $3))
       RETURNING id, caller_identity, vapi_call_id, created_at`,
      [SIM_TIER1_MINUTES, SIM_TIER2_MINUTES, SIM_SCORING_STALE_MINUTES]
    );

    if (rowCount > 0) {
      const tier1 = rows.filter(r => !r.vapi_call_id);
      const tier2 = rows.filter(r => r.vapi_call_id);
      console.warn(`stale-sweep: cleaned ${rowCount} stuck sim(s) — tier1=${tier1.length} tier2=${tier2.length}`);
      logEvent('sweep', 'stale-sweep', `cleaned ${rowCount} stuck sim(s)`, { detail: { ids: rows.map(r => r.id), callers: rows.map(r => r.caller_identity), tier1: tier1.length, tier2: tier2.length } });
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
              text: `*${rowCount} practice call(s)* auto-cleaned.\n`
                + `• *Tier 1* (iOS never connected / Vapi never dialed, >${SIM_TIER1_MINUTES}min): ${tier1.length}\n`
                + `• *Tier 2* (Vapi connected, end-of-call webhook never arrived, >${SIM_TIER2_MINUTES}min): ${tier2.length}\n\n`
                + `*Callers:* ${names}\n*Row IDs:* ${ids}\n\n`
                + `Tier 2 rows may be admin-rescore-able via \`POST /api/sim/call/{id}/rescore\` if transcripts surface later.`,
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
