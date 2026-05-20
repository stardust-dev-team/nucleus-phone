#!/usr/bin/env node
/**
 * End-to-end smoke wrapper for the M3 sim bridge.
 *
 * Bundles the three steps q0z's checklist needs you to do by hand:
 *   1. POST /api/sim/call/ios -> mint a sim row, get simCallId + conferenceName
 *   2. Dial a real PSTN leg into sim-{id} via sim-smoke-leg.js
 *   3. Tail debug_events for that call_id so you can watch Steps 3/4/6
 *      verifications stream live
 *
 * Usage:
 *   node scripts/sim-smoke.js <personaId> <difficulty> <rep-phone-E164> [--timeout 90]
 *
 * Example:
 *   node scripts/sim-smoke.js mike-garza easy +16025551234
 *
 * Exit codes:
 *   0 — tail reached terminal status (or timeout cleanly elapsed)
 *   1 — usage error, env-var missing, or operational failure
 *   130 — interrupted (SIGINT/SIGTERM)
 *
 * Required env (loaded from .env or ~/.joruva/secrets.env via lib/load-env):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   NUCLEUS_PHONE_NUMBER
 *   NUCLEUS_PHONE_API_KEY   - x-api-key for /api/sim/call/ios
 *   DATABASE_URL            - Postgres for debug_events tail + bridge-field poll
 *
 * Optional env:
 *   NUCLEUS_PHONE_BASE_URL  - defaults to https://nucleus-phone.onrender.com
 */

require('./lib/load-env')();

const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');

const E164_RE = /^\+\d{6,15}$/;
const CONFERENCE_LAND_GRACE_MS = 500;
const POLL_INTERVAL_MS = 1500;
// startTs lookback to catch events that landed between mint and tail-start.
const BACKFILL_MS = 2000;
const FETCH_TIMEOUT_MS = 15000;
const DIAL_LEG_TIMEOUT_MS = 30000;
const SIGKILL_GRACE_MS = 5000;
const MAX_TAIL_TIMEOUT_S = 1800;
const MINT_RETRY_DELAYS_MS = [500, 1500, 4000];
const MAX_DETAIL_BYTES = 1024;
const BRIDGE_FIELDS = ['vapi_call_id', 'conference_sid', 'monitor_listen_url', 'monitor_control_url'];
const TERMINAL_STATUSES = new Set(['completed', 'score-failed', 'cancelled']);
const REQUIRED_TWILIO_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'NUCLEUS_PHONE_NUMBER'];

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node scripts/sim-smoke.js <personaId> <difficulty> <rep-phone-E164> [--timeout 90]');
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let timeout = 90;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') {
      timeout = parseInt(args[++i], 10);
      if (!Number.isFinite(timeout) || timeout <= 0) usage('--timeout must be a positive integer (seconds)');
      if (timeout > MAX_TAIL_TIMEOUT_S) usage(`--timeout exceeds ${MAX_TAIL_TIMEOUT_S}s cap`);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length < 3) usage('personaId, difficulty, and rep phone are required');
  const [personaId, difficulty, to] = positional;
  if (!E164_RE.test(to)) usage(`rep phone must be E.164, got ${JSON.stringify(to)}`);
  return { personaId, difficulty, to, timeout };
}

function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function mintSimRow({ baseUrl, apiKey, personaId, difficulty }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/sim/call/ios`;
  const attempts = MINT_RETRY_DELAYS_MS.length + 1;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ personaId, difficulty }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      // 5xx retries cover Render cold starts + transient gateway errors.
      // 4xx is the caller's fault — fail fast.
      if (res.status >= 500 && i < MINT_RETRY_DELAYS_MS.length) {
        console.warn(`[info] mint attempt ${i + 1} got ${res.status}, retrying in ${MINT_RETRY_DELAYS_MS[i]}ms`);
        await sleep(MINT_RETRY_DELAYS_MS[i]);
        continue;
      }
      if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${res.statusText}\n${text}`);
      try { return JSON.parse(text); }
      catch (e) { throw new Error(`POST ${url} returned non-JSON body:\n${text}`); }
    } catch (err) {
      lastErr = err;
      // Network / abort errors get the same retry path.
      if (i < MINT_RETRY_DELAYS_MS.length && (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
        console.warn(`[info] mint attempt ${i + 1} failed (${err.message}), retrying in ${MINT_RETRY_DELAYS_MS[i]}ms`);
        await sleep(MINT_RETRY_DELAYS_MS[i]);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('mint failed after retries');
}

function dialLeg({ simCallId, to }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, 'sim-smoke-leg.js'),
      String(simCallId),
      to,
    ], { stdio: 'inherit' });
    let settled = false;
    const finish = (fn, ...args) => { if (!settled) { settled = true; fn(...args); } };
    const termTimer = setTimeout(() => {
      child.kill('SIGTERM');
      // Escalate to SIGKILL if SIGTERM doesn't take. .unref() so the kill
      // timer doesn't itself keep the event loop alive after we've rejected.
      setTimeout(() => child.kill('SIGKILL'), SIGKILL_GRACE_MS).unref();
      finish(reject, new Error(`sim-smoke-leg.js timed out after ${DIAL_LEG_TIMEOUT_MS}ms`));
    }, DIAL_LEG_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(termTimer);
      finish(reject, new Error(`sim-smoke-leg.js spawn error: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      clearTimeout(termTimer);
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`sim-smoke-leg.js exited code=${code} signal=${signal || 'none'}`));
    });
  });
}

function truncateDetail(detail) {
  const s = JSON.stringify(detail);
  if (s.length <= MAX_DETAIL_BYTES) return s;
  return `${s.slice(0, MAX_DETAIL_BYTES)}...[truncated ${s.length - MAX_DETAIL_BYTES}B]`;
}

async function safeQuery(pool, sql, params, label) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    console.warn(`[warn] ${label} query failed (${err.message}) — continuing tail`);
    return { rows: [] };
  }
}

async function tailDebugEvents({ pool, conferenceName, simCallId, deadline, startTs }) {
  // Watermark-based pagination: advance (ts, id) tuple after each batch so
  // each poll fetches only new rows. Logic is keyset pagination; correctness
  // depends on `ORDER BY ts ASC, id ASC` matching the OR predicate.
  let watermarkTs = startTs;
  let watermarkId = 0;
  const lastBridge = Object.fromEntries(BRIDGE_FIELDS.map((f) => [f, null]));
  lastBridge.status = null;
  let warnedMissingRow = false;

  console.log(`[info] Tailing debug_events + sim_call_scores for ${conferenceName} (simCallId=${simCallId})`);
  console.log(`[info] debug_events requires server-side DEBUG=1; bridge console.log lines won't appear here.`);

  while (Date.now() < deadline) {
    // sim_call_scores first so terminal-state transitions print before any
    // same-window debug_events from after the transition.
    const { rows: simRows } = await safeQuery(
      pool,
      `SELECT vapi_call_id, conference_sid, monitor_listen_url, monitor_control_url, status
         FROM sim_call_scores WHERE id = $1`,
      [simCallId],
      'sim_call_scores'
    );
    if (!simRows[0]) {
      if (!warnedMissingRow) {
        console.warn(`[warn] sim_call_scores row id=${simCallId} not found yet (server commit lag?)`);
        warnedMissingRow = true;
      }
    } else {
      const r = simRows[0];
      for (const field of BRIDGE_FIELDS) {
        if (r[field] && r[field] !== lastBridge[field]) {
          console.log(`[bridge] ${field} = ${r[field]}`);
          lastBridge[field] = r[field];
        }
      }
      if (r.status !== lastBridge.status) {
        console.log(`[bridge] status: ${lastBridge.status || '(initial)'} -> ${r.status}`);
        lastBridge.status = r.status;
      }
      if (TERMINAL_STATUSES.has(r.status)) {
        console.log(`[info] sim reached terminal status (${r.status}) — exiting tail.`);
        return;
      }
    }

    // debug_events match by either the call_id column OR detail.callId.
    // Some writers set opts.callId (column), others put it only in detail.
    const { rows } = await safeQuery(
      pool,
      `SELECT id, ts, category, source, level, summary, detail
         FROM debug_events
        WHERE (ts > $1 OR (ts = $1 AND id > $2))
          AND (call_id = $3 OR (detail->>'callId') = $3)
        ORDER BY ts ASC, id ASC`,
      [watermarkTs, watermarkId, conferenceName],
      'debug_events'
    );
    for (const r of rows) {
      const ts = new Date(r.ts).toISOString().slice(11, 23);
      console.log(`[${ts}] ${(r.level || 'info').padEnd(5)} ${r.category}/${r.source}  ${r.summary}`);
      if (r.detail && Object.keys(r.detail).length > 0) {
        console.log(`        ${truncateDetail(r.detail)}`);
      }
      watermarkTs = r.ts;
      watermarkId = r.id;
    }

    // Race the poll-interval sleep against the deadline so a Ctrl-C or
    // expiring deadline mid-sleep doesn't wait a full POLL_INTERVAL_MS.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }
  console.log(`[info] Tail timeout reached.`);
}

// Heuristic SSL selection. SSL on for everything except explicit local
// addresses or sslmode=disable in the URL. Userinfo (user:pass@) is optional;
// IPv6 ::1 is handled. Render's managed Postgres needs rejectUnauthorized:
// false because the platform CA is self-signed.
function pgSslFor(dbUrl) {
  if (/^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(dbUrl)) return false;
  if (/[?&]sslmode=disable\b/i.test(dbUrl)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const { personaId, difficulty, to, timeout } = parseArgs(process.argv);

  const baseUrl = process.env.NUCLEUS_PHONE_BASE_URL || 'https://nucleus-phone.onrender.com';
  const apiKey = process.env.NUCLEUS_PHONE_API_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!apiKey) throw new Error('NUCLEUS_PHONE_API_KEY env var is required');
  if (!dbUrl) throw new Error('DATABASE_URL env var is required (for debug_events tail)');
  // Validate Twilio creds in the PARENT before minting — otherwise we'd
  // create a sim_call_scores row and only discover the missing var when the
  // child process exits non-zero, leaving an orphan in-progress row.
  for (const v of REQUIRED_TWILIO_VARS) {
    if (!process.env[v]) throw new Error(`${v} env var is required`);
  }

  const pool = new Pool({ connectionString: dbUrl, ssl: pgSslFor(dbUrl) });
  let poolEnded = false;
  async function endPoolOnce() {
    if (poolEnded) return;
    poolEnded = true;
    try { await pool.end(); } catch (e) { /* swallow */ }
  }
  async function shutdown(sig) {
    console.error(`\n[info] Received ${sig}, cleaning up...`);
    await endPoolOnce();
    process.exit(130);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    console.log(`[info] Minting sim row at ${baseUrl} (persona=${personaId}, difficulty=${difficulty})`);
    const minted = await mintSimRow({ baseUrl, apiKey, personaId, difficulty });
    console.log(`[info] simCallId=${minted.simCallId}  conferenceName=${minted.conferenceName}`);

    // Capture startTs IMMEDIATELY after mint, BEFORE dialLeg. The bridge can
    // fire as soon as the rep leg joins, which can be only seconds after the
    // outbound dial returns. Anchoring startTs after dialLeg risks missing
    // early debug_events.
    const startTs = new Date(Date.now() - BACKFILL_MS);

    // 500ms gap lets the server's createConference() mutation land before
    // the outbound leg can race the conference-start webhook.
    await sleep(CONFERENCE_LAND_GRACE_MS);

    console.log(`[info] Dialing rep leg into ${minted.conferenceName} -> ${to}`);
    await dialLeg({ simCallId: minted.simCallId, to });

    await tailDebugEvents({
      pool,
      conferenceName: minted.conferenceName,
      simCallId: minted.simCallId,
      startTs,
      deadline: Date.now() + timeout * 1000,
    });
  } finally {
    await endPoolOnce();
  }
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
