/**
 * routes/sim.js — Practice call simulation endpoints.
 * sessionAuth required — req.user.identity used by guards.
 */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sessionAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { createOutboundCall, createWebCall, stopCall } = require('../lib/vapi');
const { scoreTranscript } = require('../lib/sim-scorer');
const { sendSlackAlert, sendAdminReport, formatSimScorecard, formatAdminReport } = require('../lib/slack');
const team = require('../config/team.json');

const router = Router();

const E164_RE = /^\+[1-9]\d{6,14}$/;
const ID_RE = /^\d+$/;

const DIFFICULTY_TO_ASSISTANT = {
  easy: 'VAPI_SIM_EASY_ID',
  medium: 'VAPI_SIM_MEDIUM_ID',
  hard: 'VAPI_SIM_HARD_ID',
};

// Load phone numbers from gitignored secrets file, fall back to env vars (PHONE_TOM, etc.)
let phoneSecrets = {};
try {
  phoneSecrets = require('../config/team-phones.json');
} catch {
  console.warn('SIM: team-phones.json not found — falling back to PHONE_* env vars');
}

function lookupPhone(identity) {
  // 1. Secrets file (gitignored)
  if (phoneSecrets[identity]) return phoneSecrets[identity];
  // 2. Env var fallback (e.g. PHONE_TOM)
  const envKey = `PHONE_${identity.toUpperCase()}`;
  return process.env[envKey] || null;
}

function validateId(req, res) {
  if (!ID_RE.test(req.params.id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return false;
  }
  return true;
}

// Compute prompt version hash (first 8 chars of MD5).
// Cached for process lifetime — invalidated on deploy (Render restarts the process).
const PERSONAS_DIR = path.join(__dirname, '..', '..', 'config', 'sim-personas');
const promptVersionCache = {};
function getPromptVersion(difficulty) {
  if (promptVersionCache[difficulty]) return promptVersionCache[difficulty];
  const filePath = path.join(PERSONAS_DIR, `mike-garza-${difficulty}.txt`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    promptVersionCache[difficulty] = hash;
    return hash;
  } catch (err) {
    console.error(`SIM: failed to read persona file ${filePath}: ${err.message}`);
    return 'unknown';
  }
}

// Startup checks
if (!process.env.SLACK_SALES_WEBHOOK_URL) {
  console.warn('SIM: Slack webhook not configured — scorecards will not post.');
}
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_ADMIN_CHANNEL_ID) {
  console.warn('SIM: SLACK_BOT_TOKEN or SLACK_ADMIN_CHANNEL_ID not set — admin mentoring reports will not post.');
}
if (!process.env.VAPI_WEBHOOK_SECRET) {
  console.error('SIM: VAPI_WEBHOOK_SECRET not set — webhook endpoint will reject ALL requests. Scoring will not work.');
}

/** Persist scored results to a sim_call_scores row. Used by both webhook and rescore. */
async function persistScores(rowId, result) {
  await pool.query(
    `UPDATE sim_call_scores SET
       score_rapport = $1, note_rapport = $2,
       score_discovery = $3, note_discovery = $4,
       score_objection = $5, note_objection = $6,
       score_product = $7, note_product = $8,
       score_close = $9, note_close = $10,
       score_overall = $11, call_grade = $12,
       top_strength = $13, top_improvement = $14,
       caller_debrief = $15, admin_report = $16,
       status = 'scored', scored_at = NOW()
     WHERE id = $17`,
    [
      result.scores.rapport, result.notes.rapport,
      result.scores.discovery, result.notes.discovery,
      result.scores.objection, result.notes.objection,
      result.scores.product, result.notes.product,
      result.scores.close, result.notes.close,
      result.overall, result.grade,
      result.topStrength, result.topImprovement,
      result.callerDebrief, result.adminReport,
      rowId,
    ]
  );
}

// ─── POST /call — Initiate practice call ───────────────────────────
// mode: 'phone' (default) calls the user's phone, 'browser' uses WebRTC.
router.post('/call', sessionAuth, async (req, res) => {
  const { difficulty, mode = 'phone' } = req.body;
  const identity = req.user.identity;

  // Validate difficulty
  if (!difficulty || !DIFFICULTY_TO_ASSISTANT[difficulty]) {
    return res.status(400).json({ error: 'Invalid difficulty. Must be: easy, medium, hard' });
  }

  // Phone mode requires a configured number
  if (mode === 'phone') {
    const phone = lookupPhone(identity);
    if (!phone) {
      return res.status(400).json({ error: `No phone configured for ${identity}. Use browser mode instead.` });
    }
    if (!E164_RE.test(phone)) {
      return res.status(400).json({ error: `Invalid phone format for ${identity}: ${phone}` });
    }
  }

  // Guard: live call in progress
  const { rows: liveCalls } = await pool.query(
    `SELECT id FROM nucleus_phone_calls
     WHERE caller_identity = $1 AND status IN ('connecting', 'in-progress')
     LIMIT 1`,
    [identity]
  );
  if (liveCalls.length > 0) {
    return res.status(409).json({ error: "You're on a live call — finish it before starting practice" });
  }

  // Guard: duplicate practice call
  const { rows: activeSim } = await pool.query(
    `SELECT id FROM sim_call_scores
     WHERE caller_identity = $1 AND status = 'in-progress'
       AND created_at > NOW() - INTERVAL '10 minutes'
     LIMIT 1`,
    [identity]
  );
  if (activeSim.length > 0) {
    return res.status(429).json({ error: 'Practice call already in progress' });
  }

  // Resolve assistant ID
  const assistantId = process.env[DIFFICULTY_TO_ASSISTANT[difficulty]];
  if (!assistantId) {
    return res.status(500).json({ error: `Missing env var ${DIFFICULTY_TO_ASSISTANT[difficulty]}` });
  }

  // Call Vapi FIRST so we have the call ID before inserting.
  let call;
  try {
    if (mode === 'browser') {
      call = await createWebCall({ assistantId });
    } else {
      const phone = lookupPhone(identity);
      call = await createOutboundCall({ assistantId, customerNumber: phone });
    }
  } catch (err) {
    console.error('Vapi call initiation failed:', err.message);
    return res.status(502).json({ error: 'Failed to initiate practice call' });
  }

  const promptVersion = getPromptVersion(difficulty);
  const listenUrl = call.monitor?.listenUrl || null;
  const controlUrl = call.monitor?.controlUrl || null;
  try {
    const { rows: [row] } = await pool.query(
      `INSERT INTO sim_call_scores (vapi_call_id, caller_identity, difficulty, prompt_version, status, monitor_listen_url, monitor_control_url)
       VALUES ($1, $2, $3, $4, 'in-progress', $5, $6)
       RETURNING id`,
      [call.id, identity, difficulty, promptVersion, listenUrl, controlUrl]
    );
    const response = { simCallId: row.id, vapiCallId: call.id };
    if (mode === 'browser' && call.webCallUrl) {
      response.webCallUrl = call.webCallUrl;
    }
    res.json(response);
  } catch (err) {
    console.error('sim: INSERT failed after Vapi call initiated, stopping orphan:', err.message);
    stopCall(call.id).catch(e => console.warn('sim: failed to stop orphan:', e.message));
    res.status(500).json({ error: 'Failed to record practice call' });
  }
});

// ─── GET /call/:id/status — Poll call status ──────────────────────
// Intentionally team-visible (any authenticated user can poll any call).
// The frontend polls its own call, but allowing cross-user visibility lets
// admins monitor and debug practice calls. Same policy as score history (#17).
router.get('/call/:id/status', sessionAuth, async (req, res) => {
  if (!validateId(req, res)) return;
  const { rows } = await pool.query(
    `SELECT status, score_overall, call_grade, duration_seconds,
            top_strength, top_improvement, caller_debrief
     FROM sim_call_scores WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const r = rows[0];
  res.json({
    status: r.status,
    score_overall: r.score_overall ? Number(r.score_overall) : null,
    grade: r.call_grade,
    duration_seconds: r.duration_seconds,
    top_strength: r.top_strength,
    top_improvement: r.top_improvement,
    caller_debrief: r.caller_debrief,
  });
});

// ─── GET /call/:id/listen — Admin-only: get listen URL for active sim call ──
router.get('/call/:id/listen', sessionAuth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  if (!validateId(req, res)) return;
  const { rows } = await pool.query(
    `SELECT monitor_listen_url, status FROM sim_call_scores WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const r = rows[0];
  if (r.status !== 'in-progress') {
    return res.status(410).json({ error: 'Call no longer active' });
  }
  if (!r.monitor_listen_url) {
    return res.status(404).json({ error: 'No listen URL available for this call' });
  }
  res.json({ listenUrl: r.monitor_listen_url });
});

// ─── GET /scores/:identity — Score history ─────────────────────────
// Intentionally team-visible (no identity gate). Score history is a coaching
// tool — visibility encourages healthy competition. See plan Decision #17.
router.get('/scores/:identity', sessionAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, difficulty, score_overall, call_grade, duration_seconds,
            score_rapport, note_rapport, score_discovery, note_discovery,
            score_objection, note_objection, score_product, note_product,
            score_close, note_close, top_strength, top_improvement,
            recording_url, caller_debrief, prompt_version, status, created_at
     FROM sim_call_scores
     WHERE caller_identity = $1 AND status IN ('scored', 'score-failed')
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.params.identity]
  );
  res.json({ scores: rows.map(r => ({ ...r, score_overall: r.score_overall ? Number(r.score_overall) : null })) });
});

// ─── GET /scoreboard — Team practice leaderboard ───────────────────
router.get('/scoreboard', sessionAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT caller_identity,
      COUNT(*) AS practice_count,
      AVG(score_overall)::numeric(3,1) AS avg_score,
      MAX(score_overall)::numeric(3,1) AS best_score,
      MAX(created_at) AS last_practiced
    FROM sim_call_scores
    WHERE status = 'scored'
      AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY caller_identity
    ORDER BY avg_score DESC
    LIMIT 50
  `);

  const nameMap = Object.fromEntries(team.members.map(m => [m.identity, m.name]));
  const leaderboard = rows.map(r => ({
    identity: r.caller_identity,
    displayName: nameMap[r.caller_identity] || r.caller_identity,
    practiceCount: parseInt(r.practice_count, 10),
    avgScore: r.avg_score ? Number(r.avg_score) : null,
    bestScore: r.best_score ? Number(r.best_score) : null,
    lastPracticed: r.last_practiced,
  }));

  res.json({ leaderboard, period: '30d' });
});

// ─── POST /call/:id/cancel — Cancel in-progress call ──────────────
router.post('/call/:id/cancel', sessionAuth, async (req, res) => {
  if (!validateId(req, res)) return;
  const { rows } = await pool.query(
    "SELECT id, vapi_call_id, status, caller_identity FROM sim_call_scores WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  if (rows[0].caller_identity !== req.user.identity && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  if (rows[0].status !== 'in-progress') {
    return res.status(409).json({ error: `Cannot cancel — status is ${rows[0].status}` });
  }

  if (rows[0].vapi_call_id) {
    try { await stopCall(rows[0].vapi_call_id); } catch (err) {
      console.warn('Vapi stop failed (may have already ended):', err.message);
    }
  }

  await pool.query(
    "UPDATE sim_call_scores SET status = 'cancelled' WHERE id = $1",
    [req.params.id]
  );
  res.json({ cancelled: true });
});

// ─── POST /call/:id/rescore — Re-score a failed row (admin only) ──
router.post('/call/:id/rescore', sessionAuth, async (req, res) => {
  if (!validateId(req, res)) return;
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const { rows } = await pool.query(
    "SELECT id, transcript, difficulty, status FROM sim_call_scores WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  if (rows[0].status !== 'score-failed') {
    return res.status(400).json({ error: `Cannot rescore — status is ${rows[0].status}` });
  }
  if (!rows[0].transcript) {
    return res.status(400).json({ error: 'No transcript to score' });
  }

  await pool.query(
    "UPDATE sim_call_scores SET status = 'scoring' WHERE id = $1",
    [req.params.id]
  );

  // Run scoring synchronously for rescore (admin is waiting)
  const result = await scoreTranscript(rows[0].transcript, rows[0].difficulty);
  if (result.error) {
    await pool.query(
      "UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1",
      [rows[0].id]
    );
    return res.status(500).json({ error: result.message });
  }

  await persistScores(rows[0].id, result);
  res.json({ rescored: true, grade: result.grade, overall: result.overall });
});

// ─── POST /webhook — Vapi end-of-call-report ──────────────────────
// No auth middleware — validates x-vapi-secret header manually.
router.post('/webhook', async (req, res) => {
  // Hard-require webhook secret
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || req.headers['x-vapi-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { message } = req.body || {};
  if (!message || message.type !== 'end-of-call-report') {
    return res.sendStatus(200); // Ignore non-end-of-call events
  }

  const { artifact, call } = message;
  const vapiCallId = call?.id;
  if (!vapiCallId) return res.sendStatus(200);

  const transcript = artifact?.transcript || null;
  const recording = artifact?.recordingUrl || artifact?.recording?.url || null;
  const duration = typeof call?.duration === 'number' ? Math.round(call.duration) : null;
  const costCents = typeof call?.cost === 'number' ? Math.round(call.cost * 100) : null;

  // Update the existing row (created by POST /call, which calls Vapi first then INSERTs).
  // The call-first pattern means the row always exists before the webhook fires,
  // so a simple UPDATE is sufficient — no upsert or retry needed.
  let rows;
  try {
    ({ rows } = await pool.query(
      `UPDATE sim_call_scores SET
         transcript = $2,
         recording_url = $3,
         duration_seconds = $4,
         cost_cents = $5,
         status = 'scoring'
       WHERE vapi_call_id = $1
       RETURNING id, caller_identity, difficulty`,
      [vapiCallId, transcript, recording, duration, costCents]
    ));
  } catch (err) {
    console.error(`sim webhook: UPDATE failed for ${vapiCallId}:`, err.message);
    return res.sendStatus(500);
  }

  // 200 — Vapi doesn't need to wait for scoring (500 returned above on DB failure)
  res.sendStatus(200);

  if (!rows.length) {
    console.warn(`sim webhook: no row for vapi_call_id ${vapiCallId}`);
    return;
  }

  // Async scoring pipeline (fire-and-forget after 200 response).
  // Wrapped with .catch() to prevent unhandled promise rejections.
  const row = rows[0];
  (async () => {
    if (!transcript) {
      await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      console.warn(`sim webhook: no transcript for call ${vapiCallId}`);
      return;
    }

    const result = await scoreTranscript(transcript, row.difficulty);
    if (result.error) {
      console.error(`sim scoring failed for ${vapiCallId}:`, result.message);
      await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      return;
    }

    await persistScores(row.id, result);

    // Slack: public scorecard to sales channel, admin report to managers channel
    const { rows: [scored] } = await pool.query(
      'SELECT * FROM sim_call_scores WHERE id = $1',
      [row.id]
    );
    const slackMsg = formatSimScorecard(scored);
    const sent = await sendSlackAlert(slackMsg);
    if (sent) {
      await pool.query("UPDATE sim_call_scores SET slack_notified = true WHERE id = $1", [row.id]);
    } else {
      console.warn(`sim: Slack scorecard failed to post for call ${vapiCallId}`);
    }
    if (scored.admin_report) {
      sendAdminReport(formatAdminReport(scored))
        .catch(err => console.warn(`sim: admin report failed for ${vapiCallId}:`, err.message));
    }
  })().catch(err => {
    console.error(`sim scoring pipeline error for ${vapiCallId}:`, err.message);
    pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id])
      .catch(dbErr => console.error(`sim: failed to mark score-failed for ${row.id}:`, dbErr.message));
  });
});

module.exports = router;
