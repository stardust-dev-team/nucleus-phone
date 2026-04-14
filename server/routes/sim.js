/**
 * routes/sim.js — Practice call simulation endpoints.
 * sessionAuth required — req.user.identity used by guards.
 */

const { Router } = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sessionAuth } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { pool } = require('../db');
const { createOutboundCall, stopCall, stopCallAndLog, getCall } = require('../lib/vapi');
const { scoreTranscript } = require('../lib/sim-scorer');
const { sendSlackAlert, sendAdminReport, sendSystemAlert, formatSimScorecard, formatAdminReport } = require('../lib/slack');
const { broadcast } = require('../lib/live-analysis');
const { processEquipmentChunk } = require('../lib/equipment-pipeline');
const { processConversationChunk, getCallEventLog, cleanupConversation } = require('../lib/conversation-pipeline');
const { logEvent } = require('../lib/debug-log');
const { touch } = require('../lib/health-tracker');
const team = require('../config/team.json');

const router = Router();

// ─── Vapi webhook — registered BEFORE auth middleware ────────────────────────
// Vapi sends server events (transcript, end-of-call-report) with no session
// cookie. Auth is handled via x-vapi-secret header inside the handler.
// This MUST be above router.use(sessionAuth) or it gets 401'd.
router.post('/webhook', webhookHandler);

// Practice mode is open to every logged-in caller (including external).
// The in-route sessionAuth calls are preserved for fidelity to the old
// per-route policy but this mount-level guard is the real gate.
router.use(sessionAuth, rbac('external_caller'));

const E164_RE = /^\+[1-9]\d{6,14}$/;
const ID_RE = /^\d+$/;

const DIFFICULTY_TO_ASSISTANT = {
  easy: 'VAPI_SIM_EASY_ID',
  medium: 'VAPI_SIM_MEDIUM_ID',
  hard: 'VAPI_SIM_HARD_ID',
};

// Greeting pools — randomized per call so reps don't memorize the opener.
const GREETING_POOLS = {
  easy: [
    "Garza Precision, this is Mike. What can I do for you?",
    "Hey, Mike Garza.",
    "This is Mike at Garza Precision, how can I help you?",
    "Garza Precision, Mike speaking.",
  ],
  medium: [
    "Yeah, this is Mike.",
    "Mike speaking.",
    "Garza Precision.",
    "This is Mike.",
  ],
  hard: [
    "Garza Precision.",
    "Yeah.",
    "Mike.",
    "Hello???",
  ],
};

function pickGreeting(difficulty) {
  const pool = GREETING_POOLS[difficulty];
  return pool[Math.floor(Math.random() * pool.length)];
}

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

  // Browser mode: client creates the call via Vapi Web SDK, server just
  // reserves the DB row and returns the assistantId + publicKey.
  // Phone mode: server creates the call via Vapi API as before.
  if (mode === 'browser') {
    const publicKey = process.env.VAPI_PUBLIC_KEY;
    if (!publicKey) {
      return res.status(500).json({ error: 'VAPI_PUBLIC_KEY not set' });
    }
    const promptVersion = getPromptVersion(difficulty);
    try {
      const { rows: [row] } = await pool.query(
        `INSERT INTO sim_call_scores (caller_identity, difficulty, prompt_version, status)
         VALUES ($1, $2, $3, 'in-progress')
         RETURNING id`,
        [identity, difficulty, promptVersion]
      );
      res.json({ simCallId: row.id, assistantId, publicKey, firstMessage: pickGreeting(difficulty) });
    } catch (err) {
      console.error('sim: INSERT failed:', err.message);
      res.status(500).json({ error: 'Failed to record practice call' });
    }
    return;
  }

  // Phone mode: server creates the Vapi call
  let call;
  try {
    const phone = lookupPhone(identity);
    const greeting = pickGreeting(difficulty);
    call = await createOutboundCall({
      assistantId,
      customerNumber: phone,
      assistantOverrides: { firstMessage: greeting },
    });
  } catch (err) {
    console.error('Vapi call initiation failed:', err.message);
    sendSystemAlert(
      `🔴 Practice Call Failed — Vapi error for ${identity}`,
      [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Vapi call initiation failed*\n*Caller:* ${identity}\n*Difficulty:* ${difficulty}\n*Mode:* ${mode}\n*Error:* ${err.message}` },
      }]
    ).catch(() => {});
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
    res.json({ simCallId: row.id, vapiCallId: call.id });
  } catch (err) {
    console.error('sim: INSERT failed after Vapi call initiated, stopping orphan:', err.message);
    stopCall(call.id).catch(stopErr => {
      console.error('sim: ORPHAN Vapi call could not be stopped:', stopErr.message);
      sendSystemAlert(
        `🔴 Orphan Vapi Call — manual cleanup required`,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*DB insert failed AND Vapi stop failed — live call burning minutes with no DB row.*\n*Vapi Call ID:* \`${call.id}\`\n*Caller:* ${identity}\n*DB error:* ${err.message}\n*Stop error:* ${stopErr.message} (status ${stopErr.status || 'n/a'})\n*Action:* End this call manually in the Vapi dashboard.` },
        }]
      ).catch(() => {});
    });
    res.status(500).json({ error: 'Failed to record practice call' });
  }
});

// ─── POST /call/:id/link-vapi — Link a browser-initiated Vapi call to the DB row
// Called by the client after Vapi Web SDK creates the call. Must complete before
// webhooks arrive — Vapi sends transcript events within milliseconds of call start.
const VAPI_CALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/call/:id/link-vapi', sessionAuth, async (req, res) => {
  if (!validateId(req, res)) return;
  const { vapiCallId } = req.body;
  if (!vapiCallId || typeof vapiCallId !== 'string' || !VAPI_CALL_ID_RE.test(vapiCallId)) {
    return res.status(400).json({ error: 'vapiCallId must be a valid UUID' });
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE sim_call_scores SET vapi_call_id = $1
       WHERE id = $2 AND caller_identity = $3 AND vapi_call_id IS NULL`,
      [vapiCallId, req.params.id, req.user.identity]
    );
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Row not found or already linked' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`sim link-vapi: DB error for row ${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to link Vapi call' });
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

// ─── POST /call/:id/cancel — End call early and score what we have ──
router.post('/call/:id/cancel', sessionAuth, async (req, res) => {
  if (!validateId(req, res)) return;
  const { rows } = await pool.query(
    "SELECT id, vapi_call_id, status, caller_identity, difficulty FROM sim_call_scores WHERE id = $1",
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  if (rows[0].caller_identity !== req.user.identity && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your call' });
  }
  if (rows[0].status !== 'in-progress') {
    return res.status(409).json({ error: `Cannot cancel — status is ${rows[0].status}` });
  }

  const row = rows[0];

  if (row.vapi_call_id) {
    await stopCallAndLog(row.vapi_call_id);
  }

  // Fetch transcript from Vapi API — the call just ended so transcript
  // may need a moment to finalize. Try immediately, then retry after 3s.
  let transcript = null;
  let recording = null;
  if (row.vapi_call_id) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      try {
        const vapiCall = await getCall(row.vapi_call_id);
        transcript = vapiCall.artifact?.transcript || vapiCall.transcript || null;
        recording = vapiCall.artifact?.recordingUrl || vapiCall.recordingUrl || null;
        if (transcript) break;
      } catch (err) {
        console.warn(`sim cancel: Vapi fetch attempt ${attempt + 1} failed:`, err.message);
      }
    }
  }

  if (!transcript) {
    // No transcript available — mark as cancelled (call was too short)
    await pool.query("UPDATE sim_call_scores SET status = 'cancelled' WHERE id = $1", [row.id]);
    res.json({ cancelled: true });
    return;
  }

  // Transcript available — transition to scoring
  await pool.query(
    `UPDATE sim_call_scores SET transcript = $2, recording_url = $3, status = 'scoring' WHERE id = $1`,
    [row.id, transcript, recording]
  );
  res.json({ cancelled: false, scoring: true });

  // Capture navigator events then clean up conversation state
  const navEvents = getCallEventLog(`sim-${row.id}`);
  cleanupConversation(`sim-${row.id}`);

  // Fire-and-forget scoring pipeline
  (async () => {
    const result = await scoreTranscript(transcript, row.difficulty, row.caller_identity, navEvents);
    if (result.error) {
      console.error(`sim cancel scoring failed for ${row.vapi_call_id}:`, result.message);
      await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      return;
    }
    await persistScores(row.id, result);
    const { rows: [scored] } = await pool.query('SELECT * FROM sim_call_scores WHERE id = $1', [row.id]);
    const slackMsg = formatSimScorecard(scored);
    const sent = await sendSlackAlert(slackMsg);
    if (sent) await pool.query("UPDATE sim_call_scores SET slack_notified = true WHERE id = $1", [row.id]);
    if (scored.admin_report) {
      sendAdminReport(formatAdminReport(scored)).catch(() => {});
    }
  })().catch(err => {
    console.error(`sim cancel scoring pipeline error for ${row.id}:`, err.message);
    pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]).catch(() => {});
  });
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
  const result = await scoreTranscript(rows[0].transcript, rows[0].difficulty, rows[0].caller_identity);
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

/**
 * Handle Vapi transcript server events for live equipment analysis.
 *
 * Vapi labels speakers as role:'assistant' (Mike Garza AI) and role:'user'
 * (the sales rep). Equipment mentions come from the assistant (prospect
 * simulator), so we extract from role==='assistant' transcripts only.
 */
async function handleTranscriptEvent(message) {
  // Vapi sends transcript events in two possible formats:
  //   A) transcript is an object: { text, role, transcriptType }  (legacy/phone)
  //   B) transcript is a string, role + transcriptType are top-level  (web SDK)
  const raw = message.transcript;
  const role = (typeof raw === 'object' ? raw?.role : null) || message.role;
  const transcriptType = (typeof raw === 'object' ? raw?.transcriptType : null) || message.transcriptType;
  const text = typeof raw === 'string' ? raw : raw?.text;
  const vapiCallId = message.call?.id;

  if (!vapiCallId) {
    console.warn('sim transcript: no call.id in message, keys:', Object.keys(message).join(','));
    return;
  }
  if (!text) return;

  // Only process final transcripts from the assistant (the simulated prospect)
  if (transcriptType !== 'final') return;
  if (role !== 'assistant') return;

  // Find the sim_call_scores row for this Vapi call.
  // Retry once after 2s — link-vapi may still be in flight from the client.
  let rows;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ({ rows } = await pool.query(
        'SELECT id FROM sim_call_scores WHERE vapi_call_id = $1',
        [vapiCallId]
      ));
    } catch (err) {
      console.error(`sim transcript: DB lookup failed for vapi call ${vapiCallId}:`, err.message);
      return;
    }
    if (rows.length) break;
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!rows.length) {
    console.warn(`sim transcript: no row for vapi_call_id=${vapiCallId} after retry`);
    return;
  }

  const simId = rows[0].id;
  const wsCallId = `sim-${simId}`;

  // Broadcast raw transcript chunk
  broadcast(wsCallId, {
    type: 'transcript_chunk',
    data: { text, speaker: role },
  });

  // Run entity extraction → lookup → sizing → broadcast pipeline
  await processEquipmentChunk(wsCallId, 'practice', String(simId), text);

  // Run conversation analysis pipeline (fire-and-forget, parallel to equipment)
  processConversationChunk(wsCallId, text).catch((err) => {
    console.error('sim: conversation pipeline error:', err.message);
  });
}

// ─── Vapi webhook handler (registered above auth middleware) ─────────────────
async function webhookHandler(req, res) {
  // Hard-require webhook secret
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret || req.headers['x-vapi-secret'] !== secret) {
    logEvent('webhook', 'sim.webhook', 'rejected: invalid webhook secret', { level: 'error' });
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { message } = req.body || {};
  if (!message) return res.sendStatus(200);
  touch('vapi.webhook');

  // ── Handle real-time transcript events (practice call live analysis) ──
  if (message.type === 'transcript') {
    res.sendStatus(200);
    handleTranscriptEvent(message).catch(err => {
      console.error('sim webhook: transcript handler error:', err.message);
    });
    return;
  }

  if (message.type !== 'end-of-call-report') {
    return res.sendStatus(200);
  }

  const { artifact, call } = message;
  const vapiCallId = call?.id;
  if (!vapiCallId) return res.sendStatus(200);

  let transcript = artifact?.transcript || null;
  let recording = artifact?.recordingUrl || artifact?.recording?.url || null;
  const duration = typeof call?.duration === 'number' ? Math.round(call.duration) : null;
  const costCents = typeof call?.cost === 'number' ? Math.round(call.cost * 100) : null;

  // Respond immediately — Vapi will retry if we take too long
  res.sendStatus(200);

  console.log(`sim webhook: end-of-call for ${vapiCallId} — transcript=${transcript ? 'yes' : 'MISSING'} recording=${recording ? 'yes' : 'MISSING'}`);
  logEvent('webhook', 'sim.webhook', `end-of-call: transcript=${transcript ? 'yes' : 'MISSING'}, recording=${recording ? 'yes' : 'MISSING'}`, { callId: vapiCallId });

  // Vapi sometimes fires the end-of-call webhook before transcript is ready.
  // If transcript is missing, wait 5s and fetch directly from the Vapi API.
  if (!transcript) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const vapiCall = await getCall(vapiCallId);
      transcript = vapiCall.artifact?.transcript || vapiCall.transcript || null;
      recording = recording || vapiCall.artifact?.recordingUrl || vapiCall.recordingUrl || null;
      console.log(`sim webhook: Vapi API fallback — transcript=${transcript ? 'yes (' + transcript.length + ' chars)' : 'STILL MISSING'}`);
    } catch (err) {
      console.warn(`sim webhook: Vapi API fallback failed for ${vapiCallId}:`, err.message);
    }
  }

  // Update the existing row. For browser-mode calls, vapi_call_id is set via
  // link-vapi (client-side) and may not be written yet. Retry once after 2s.
  let rows;
  for (let attempt = 0; attempt < 2; attempt++) {
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
      return;
    }
    if (rows.length) break;
    if (attempt === 0) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!rows.length) {
    console.warn(`sim webhook: no row for vapi_call_id ${vapiCallId} after retry`);
    return;
  }

  // Capture navigator events then clean up conversation state
  const row = rows[0];
  const webhookNavEvents = getCallEventLog(`sim-${row.id}`);
  cleanupConversation(`sim-${row.id}`);

  // Async scoring pipeline (fire-and-forget after 200 response).
  (async () => {
    if (!transcript) {
      await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      console.warn(`sim webhook: no transcript for call ${vapiCallId} even after API fallback`);
      return;
    }

    const result = await scoreTranscript(transcript, row.difficulty, row.caller_identity, webhookNavEvents);
    if (result.error) {
      console.error(`sim scoring failed for ${vapiCallId}:`, result.message);
      await pool.query("UPDATE sim_call_scores SET status = 'score-failed' WHERE id = $1", [row.id]);
      sendSystemAlert(
        `🔴 Sim Scoring Failed — ${row.caller_identity}`,
        [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*Practice call scoring failed*\n*Caller:* ${row.caller_identity}\n*Difficulty:* ${row.difficulty}\n*Call ID:* ${vapiCallId}\n*Error:* ${result.message}\n\nAdmin can rescore via \`POST /api/sim/call/${row.id}/rescore\`` },
        }]
      ).catch(() => {});
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
}

module.exports = router;
