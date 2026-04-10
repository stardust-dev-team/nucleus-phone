const { Router } = require('express');
const { sessionAuth } = require('../middleware/auth');
const { pool } = require('../db');

const router = Router();

// sessionAuth (not apiKeyAuth): access control depends on req.user.identity and
// req.user.role to enforce per-caller filtering. API key auth does not set req.user.

// Columns for the list view (no transcript — too large for list)
const LIST_COLUMNS = `npc.id, npc.created_at, npc.caller_identity, npc.lead_name,
  npc.lead_company, npc.lead_phone, npc.duration_seconds, npc.disposition,
  npc.qualification, npc.ai_summary, npc.ai_action_items, npc.notes,
  npc.products_discussed, npc.recording_url, npc.conference_name`;

const CI_COLUMNS = `ci.summary AS ci_summary, ci.sentiment, ci.competitive_intel,
  ci.products_discussed AS ci_products`;

// GET /api/summaries — list call summaries with AI analysis
router.get('/', sessionAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { q } = req.query;

  // Access control: non-admin forced to own calls
  let caller;
  if (req.user.role === 'admin') {
    caller = req.query.caller || null;
  } else {
    caller = req.user.identity;
  }

  const where = ['npc.status = \'completed\''];
  const params = [];
  let idx = 1;

  if (caller) {
    where.push(`npc.caller_identity = $${idx++}`);
    params.push(caller);
  }

  // Only show calls that have some summary content
  where.push(`(npc.ai_summary IS NOT NULL OR npc.notes IS NOT NULL OR ci.summary IS NOT NULL)`);

  // Full-text search using GIN index (idx_npc_fts in db.js).
  // IMPORTANT: This expression must match the GIN index in server/db.js exactly.
  if (q && q.trim()) {
    where.push(`to_tsvector('english',
      COALESCE(npc.ai_summary,'') || ' ' || COALESCE(npc.notes,'') || ' ' ||
      COALESCE(npc.lead_name,'') || ' ' || COALESCE(npc.lead_company,''))
      @@ plainto_tsquery('english', $${idx++})`);
    params.push(q.trim());
  }

  const whereClause = where.join(' AND ');

  const joinClause = `LEFT JOIN customer_interactions ci
    ON ci.session_id = CONCAT('npc_', COALESCE(npc.conference_name, npc.id::text))`;

  try {
    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT ${LIST_COLUMNS}, ${CI_COLUMNS}
         FROM nucleus_phone_calls npc
         ${joinClause}
         WHERE ${whereClause}
         ORDER BY npc.created_at DESC
         LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM nucleus_phone_calls npc
         ${joinClause}
         WHERE ${whereClause}`,
        params
      ),
    ]);

    res.json({
      summaries: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error('Summaries fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch summaries' });
  }
});

// GET /api/summaries/:id — single summary with full transcript + AI fields
router.get('/:id', sessionAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  // Access control
  const where = ['npc.id = $1'];
  const params = [id];
  if (req.user.role !== 'admin') {
    where.push('npc.caller_identity = $2');
    params.push(req.user.identity);
  }

  try {
    const result = await pool.query(
      `SELECT npc.*, ci.summary AS ci_summary, ci.sentiment,
        ci.competitive_intel, ci.products_discussed AS ci_products,
        ci.transcript AS ci_transcript
       FROM nucleus_phone_calls npc
       LEFT JOIN customer_interactions ci
         ON ci.session_id = CONCAT('npc_', COALESCE(npc.conference_name, npc.id::text))
       WHERE ${where.join(' AND ')}`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Summary not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Summary detail failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

module.exports = router;
