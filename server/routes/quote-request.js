/**
 * quote-request.js — POST /api/quote-request
 *
 * Handles two CTA types from the LiveAssistant DirectSaleCTA component:
 *   1. type: 'audit'  — Schedule Alex Paxton callback (Slack notification)
 *   2. type: 'quote'  — Custom quote via email (DB record + Slack notification)
 *
 * Session-authenticated (same cookie auth as WebSocket — rep is logged in).
 */
const express = require('express');
const { pool } = require('../db');
const { sendSlackAlert } = require('../lib/slack');

const router = express.Router();

function formatRecommendation(rec) {
  if (!rec?.compressor) return 'No recommendation';
  const c = rec.compressor;
  const parallel = rec.parallelConfig
    ? `${rec.parallelConfig.unitCount}x ${c.model} (${rec.parallelConfig.totalCfm} CFM total)`
    : `${c.model} — ${c.hp} HP, ${c.cfm} CFM`;
  const dryer = rec.dryer ? `\nDryer: ${rec.dryer.model} (${rec.dryer.cfm} CFM)` : '';
  const filters = rec.filters?.length
    ? `\nFilters: ${rec.filters.map(f => f.model).join(', ')}`
    : '';
  return parallel + dryer + filters;
}

const MAX_RECOMMENDATION_SIZE = 10240; // 10 KB
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', async (req, res) => {
  const { type, callId, email, consent, leadName, leadCompany, leadPhone, recommendation } = req.body;

  // Validate recommendation payload size
  if (recommendation) {
    const serialized = JSON.stringify(recommendation);
    if (serialized.length > MAX_RECOMMENDATION_SIZE) {
      return res.status(400).json({ error: 'Recommendation payload too large' });
    }
  }

  if (type === 'audit') {
    // CTA 1: Alex Paxton callback — fire-and-forget Slack notification
    const slackMsg = {
      text: `📋 Compressed Air Audit Request — ${leadName || 'Unknown'} at ${leadCompany || 'Unknown'}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📋 Compressed Air Audit Request' },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Contact:*\n${leadName || 'Unknown'}` },
            { type: 'mrkdwn', text: `*Company:*\n${leadCompany || 'Unknown'}` },
            { type: 'mrkdwn', text: `*Phone:*\n${leadPhone || 'N/A'}` },
            { type: 'mrkdwn', text: `*Requested by:*\n${req.user.identity}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Recommended System:*\n\`\`\`${formatRecommendation(recommendation)}\`\`\`` },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Call ID: ${callId || 'N/A'} | Alex: schedule 10-min compressed air audit` }],
        },
      ],
    };

    // Fire-and-forget — don't block UI on Slack failure
    sendSlackAlert(slackMsg).catch(err => console.error('quote-request: audit Slack failed:', err.message));
    return res.json({ success: true, type: 'audit' });
  }

  if (type === 'quote') {
    // CTA 2: Custom quote via email — validate, store, notify
    if (!email || !consent) {
      return res.status(400).json({ error: 'Email and consent required' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    try {
      const result = await pool.query(
        `INSERT INTO quote_requests (call_id, lead_email, lead_name, lead_company, lead_phone, recommendation_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [callId, email, leadName, leadCompany, leadPhone, JSON.stringify(recommendation)]
      );
      const quoteRequestId = result.rows[0].id;

      // Slack notification — fire-and-forget, update slack_notified on success
      const slackMsg = {
        text: `📧 Custom Quote Request — ${leadName || 'Unknown'} at ${leadCompany || 'Unknown'}`,
        blocks: [
          {
            type: 'header',
            text: { type: 'plain_text', text: '📧 Custom Quote Request' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Contact:*\n${leadName || 'Unknown'}` },
              { type: 'mrkdwn', text: `*Company:*\n${leadCompany || 'Unknown'}` },
              { type: 'mrkdwn', text: `*Email:*\n${email}` },
              { type: 'mrkdwn', text: `*Phone:*\n${leadPhone || 'N/A'}` },
            ],
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Recommended System:*\n\`\`\`${formatRecommendation(recommendation)}\`\`\`` },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Quote #${quoteRequestId} | Call: ${callId || 'N/A'} | Rep: ${req.user.identity}` }],
          },
        ],
      };

      sendSlackAlert(slackMsg)
        .then(ok => {
          if (ok) pool.query('UPDATE quote_requests SET slack_notified = true WHERE id = $1', [quoteRequestId]);
        })
        .catch(err => console.error('quote-request: quote Slack failed:', err.message));

      return res.json({ success: true, type: 'quote', quoteRequestId });
    } catch (err) {
      console.error('quote-request: DB insert failed:', err.message);
      return res.status(500).json({ error: 'Failed to save quote request' });
    }
  }

  return res.status(400).json({ error: 'Invalid type — must be "audit" or "quote"' });
});

module.exports = router;
