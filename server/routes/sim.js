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
const { createOutboundCall, stopCall } = require('../lib/vapi');
const { scoreTranscript } = require('../lib/sim-scorer');
const { sendSlackAlert, formatSimScorecard } = require('../lib/slack');
const team = require('../config/team.json');

const router = Router();

const E164_RE = /^\+[1-9]\d{6,14}$/;

const DIFFICULTY_TO_ASSISTANT = {
  easy: 'VAPI_SIM_EASY_ID',
  medium: 'VAPI_SIM_MEDIUM_ID',
  hard: 'VAPI_SIM_HARD_ID',
};

// Compute prompt version hash (first 8 chars of MD5).
// Cached for process lifetime — invalidated on deploy (Render restarts the process).
const promptVersionCache = {};
function getPromptVersion(difficulty) {
  if (promptVersionCache[difficulty]) return promptVersionCache[difficulty];
  try {
    const filePath = path.join(__dirname, '..', '..', 'config', 'sim-personas', `mike-garza-${difficulty}.txt`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    promptVersionCache[difficulty] = hash;
    return hash;
  } catch {
    return 'unknown';
  }
}

function lookupPhone(identity) {
  const member = team.members.find(m => m.identity === identity);
  return member?.phone || null;
}

const ID_RE = /^\d+$/;

// Startup checks
if (!process.env.SLACK_SALES_WEBHOOK_URL) {
  console.warn('SIM: Slack webhook not configured — scorecards will not post.');
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
       status = 'scored', scored_at = NOW()
     WHERE id = $15`,
    [
      result.scores.rapport, result.notes.rapport,
      result.scores.discovery, result.notes.discovery,
      result.scores.objection, result.notes.objection,
      result.scores.product, result.notes.product,
      result.scores.close, result.notes.close,
      result.overall, result.grade,
      result.topStrength, result.topImprovement,
      rowId,
    ]
  );
}

// ─── POST /call — Initiate practice call ───────────────────────────
router.post('/call', sessionAuth, async (req, res) => {
  const { difficulty } = req.body;
  const identity = req.user.identity;

  // Validate difficulty
  if (!difficulty || !DIFFICULTY_TO_ASSISTANT[difficulty]) {
    return res.status(400).json({ error: 'Invalid difficulty. Must be: easy, medium, hard' });
  }

  // Look up phone
  const phone = lookupPhone(identity);
  if (!phone) {
    return res.status(400).json({ error: `No phone configured for ${identity} in team.json` });
  }
  if (!E164_RE.test(phone)) {
    return res.status(400).json({ error: `Invalid phone format for ${identity}: ${phone}` });
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
  // This eliminates the race where the webhook arrives before the row has vapi_call_id.
  let call;
  try {
    call = await createOutboundCall({
      assistantId,
      customerNumber: phone,
    });
  } catch (err) {
    console.error('Vapi call initiation failed:', err.message);
    return res.status(502).json({ error: 'Failed to initiate practice call' });
  }

  const promptVersion = getPromptVersion(difficulty);
  const { rows: [row] } = await pool.query(
    `INSERT INTO sim_call_scores (vapi_call_id, caller_identity, difficulty, prompt_version, status)
     VALUES ($1, $2, $3, $4, 'in-progress')
     RETURNING id`,
    [call.id, identity, difficulty, promptVersion]
  );

  res.json({ simCallId: row.id, vapiCallId: call.id });
});

// ─── GET /call/:id/status — Poll call status ──────────────────────
router.get('/call/:id/status', sessionAuth, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const { rows } = await pool.query(
    `SELECT status, score_overall, call_grade, duration_seconds,
            top_strength, top_improvement
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
  });
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
            recording_url, prompt_version, status, created_at
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
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
  const { rows } = await pool.query(
    "SELECT id, vapi_call_id, status FROM sim_call_scores WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
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
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
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

  // Update the existing row (created by POST /call).
  async function tryUpdate() {
    const { rows } = await pool.query(
      `UPDATE sim_call_scores SET
         transcript = $2,
         recording_url = $3,
         duration_seconds = $4,
         cost_cents = $5,
         status = 'scoring'
       WHERE vapi_call_id = $1
       RETURNING id, caller_identity, difficulty`,
      [vapiCallId, transcript, recording, duration, costCents]
    );
    return rows;
  }

  let rows = await tryUpdate();

  // If no row found, webhook may have beaten POST /call's INSERT.
  // Retry once after 2s to close the narrow race window.
  if (!rows.length) {
    await new Promise(r => setTimeout(r, 2000));
    rows = await tryUpdate();
  }

  // 200 immediately — Vapi doesn't need to wait for scoring
  res.sendStatus(200);

  if (!rows.length) {
    console.warn(`sim webhook: no row for vapi_call_id ${vapiCallId} after retry`);
    return;
  }

  // Async scoring pipeline — wrapped in error boundary to prevent
  // unhandled promise rejections from crashing the process
  const row = rows[0];
  setImmediate(async () => {
    try {
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

      // Slack scorecard
      const { rows: [scored] } = await pool.query(
        'SELECT * FROM sim_call_scores WHERE id = $1',
        [row.id]
      );
      const slackMsg = formatSimScorecard(scored);
      const sent = await sendSlackAlert(slackMsg);
      if (sent) {
        await pool.query("UPDATE sim_call_scores SET slack_notified = true WHERE id = $1", [row.id]);
      }
    } catch (err) {
      console.error(`sim scoring pipeline error for ${vapiCallId}:`, err.message);
      try {
        await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      } catch (dbErr) {
        console.error(`sim: failed to mark score-failed for ${row.id}:`, dbErr.message);
      }
    }
  });
});

module.exports = router;
