const { Router } = require('express');
const { sessionAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { runChat } = require('../lib/ask-nucleus');
const { escalateToTom } = require('../lib/escalation');

const router = Router();

// All ask routes require session auth (user identity needed for access control)

// POST /api/ask — Send message, get SSE stream
router.post('/', sessionAuth, async (req, res) => {
  const { message, conversationId } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message required' });
  }
  if (message.length > 4000) {
    return res.status(400).json({ error: 'message too long (max 4000 chars)' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  function sendSSE(data) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  console.log('[ask route] POST /api/ask start', { identity: req.user.identity, msgLen: message.length, conversationId });
  try {
    const result = await runChat({
      message: message.trim(),
      conversationId: conversationId || null,
      identity: req.user.identity,
      role: req.user.role,
      onTextDelta: (text) => sendSSE({ type: 'text_delta', text }),
      onToolStatus: (name) => sendSSE({ type: 'tool_status', name }),
      signal: controller.signal,
    });

    console.log('[ask route] runChat done', { conversationId: result.conversationId, escalation: !!result.escalation });
    sendSSE({
      type: 'done',
      conversationId: result.conversationId,
      escalation: result.escalation || null,
    });
  } catch (err) {
    // Client disconnect aborts — swallow silently (nothing to send to)
    const isAbort = err.name === 'AbortError' || err.cause?.name === 'AbortError' || err.message === 'aborted';
    if (isAbort) {
      console.log('[ask route] client aborted');
      return;
    }
    console.error('[ask route] error:', err.name, err.message, err.stack);
    // DEBUG_ASK_ERRORS=1 surfaces raw error.message to the client via SSE.
    // Leave off in normal operation — raw API errors can leak config details.
    const debugErrors = process.env.DEBUG_ASK_ERRORS === '1';
    const clientMsg = debugErrors
      ? `Error: ${err.message || 'Something went wrong'}`
      : 'Something went wrong. Try again.';
    sendSSE({ type: 'error', message: clientMsg });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// GET /api/ask/conversations — List user's conversations
router.get('/conversations', sessionAuth, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query(
        `SELECT id, caller_identity, created_at, updated_at, jsonb_array_length(messages) AS message_count
         FROM ask_nucleus_conversations
         ORDER BY updated_at DESC LIMIT $1`,
        [limit]
      );
    } else {
      result = await pool.query(
        `SELECT id, caller_identity, created_at, updated_at, jsonb_array_length(messages) AS message_count
         FROM ask_nucleus_conversations
         WHERE caller_identity = $1
         ORDER BY updated_at DESC LIMIT $2`,
        [req.user.identity, limit]
      );
    }

    res.json({ conversations: result.rows });
  } catch (err) {
    console.error('List conversations failed:', err.message);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// GET /api/ask/conversations/:id — Single conversation (for hook verification)
router.get('/conversations/:id', sessionAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query(
        'SELECT id, caller_identity, messages, created_at, updated_at FROM ask_nucleus_conversations WHERE id = $1',
        [id]
      );
    } else {
      result = await pool.query(
        'SELECT id, caller_identity, messages, created_at, updated_at FROM ask_nucleus_conversations WHERE id = $1 AND caller_identity = $2',
        [id, req.user.identity]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get conversation failed:', err.message);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// DELETE /api/ask/conversations/:id — Delete conversation (atomic ownership check)
router.delete('/conversations/:id', sessionAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query('DELETE FROM ask_nucleus_conversations WHERE id = $1 RETURNING id', [id]);
    } else {
      result = await pool.query(
        'DELETE FROM ask_nucleus_conversations WHERE id = $1 AND caller_identity = $2 RETURNING id',
        [id, req.user.identity]
      );
    }

    if (!result.rows.length) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete conversation failed:', err.message);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
});

// POST /api/ask/escalate — Escalate question to Tom via SMS + Slack
router.post('/escalate', sessionAuth, async (req, res) => {
  const { question, context, company, contact, conversationId } = req.body;
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question required' });
  }

  try {
    const result = await escalateToTom({
      repName: req.user.identity,
      question: question.substring(0, 500),
      context: (context || '').substring(0, 500),
      company: company || null,
      contact: contact || null,
    });

    if (result.rateLimited) {
      return res.status(429).json({
        error: 'rate_limited',
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }

    // Mark escalation in conversation if provided (with ownership check)
    if (conversationId) {
      const marker = JSON.stringify([{
        role: 'system',
        content: `Escalated to Tom: ${question}`,
        timestamp: new Date().toISOString(),
        escalated: true,
      }]);
      const isAdmin = req.user.role === 'admin';
      const sql = isAdmin
        ? 'UPDATE ask_nucleus_conversations SET messages = messages || $1::jsonb WHERE id = $2'
        : 'UPDATE ask_nucleus_conversations SET messages = messages || $1::jsonb WHERE id = $2 AND caller_identity = $3';
      const params = isAdmin ? [marker, conversationId] : [marker, conversationId, req.user.identity];
      await pool.query(sql, params)
        .catch(err => console.error('Failed to mark escalation:', err.message));
    }

    res.json({ sent: result.sent, channels: result.channels });
  } catch (err) {
    console.error('Escalation failed:', err.message);
    res.status(500).json({ error: 'Escalation failed' });
  }
});

module.exports = router;
