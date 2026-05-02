const { Router } = require('express');
const { bearerOrSession, bearerOrApiKeyOrSession } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { pool } = require('../db');
const { sendSlackAlert, formatCallAlert } = require('../lib/slack');
const { addNoteToContact, getContact } = require('../lib/hubspot');
const { formatDuration } = require('../lib/format');
const { syncInteraction } = require('../lib/interaction-sync');
const { sendFollowUpEmail } = require('../lib/email-sender');
const { lookupCustomer } = require('../lib/customer-lookup');
const { track } = require('../lib/inflight');

const router = Router();

// SAFETY: All column constants are compile-time, never user input.

// LIST_COLUMNS — used by GET / (list view). Prefixed with npc. for JOIN disambiguation.
// Omits transcript (too large for list view).
const LIST_COLUMNS = `npc.id, npc.created_at, npc.conference_name, npc.caller_identity,
  npc.lead_phone, npc.lead_name, npc.lead_company, npc.hubspot_contact_id,
  npc.direction, npc.status, npc.duration_seconds, npc.disposition, npc.qualification,
  npc.products_discussed, npc.notes, npc.recording_url, npc.recording_duration,
  npc.fireflies_uploaded, npc.lead_email, npc.follow_up_email_sent,
  npc.follow_up_email_error, npc.ai_summary, npc.ai_action_items`;

// DETAIL_COLUMNS — used by GET /:id (detail view). Explicit list (no npc.*)
// so new secret columns don't silently leak to the client.
const DETAIL_COLUMNS = `npc.id, npc.created_at, npc.conference_name, npc.caller_identity,
  npc.lead_phone, npc.lead_name, npc.lead_company, npc.hubspot_contact_id,
  npc.direction, npc.status, npc.duration_seconds, npc.disposition, npc.qualification,
  npc.products_discussed, npc.notes, npc.recording_url, npc.recording_duration,
  npc.fireflies_uploaded, npc.lead_email, npc.follow_up_email_sent,
  npc.follow_up_email_error, npc.ai_summary, npc.ai_action_items, npc.transcript`;

// CALL_COLUMNS — used by POST /:id/disposition UPDATE RETURNING (no JOIN).
const CALL_COLUMNS = `id, created_at, conference_name, caller_identity, lead_phone,
  lead_name, lead_company, hubspot_contact_id, direction, status, duration_seconds,
  disposition, qualification, products_discussed, notes, recording_url,
  recording_duration, fireflies_uploaded, lead_email, follow_up_email_sent,
  follow_up_email_error, ai_summary, ai_action_items, transcript`;

// LATERAL JOIN for customer_interactions — collapses to 1 row per call even if
// multiple ci rows exist for the same session_id. Used by GET / and GET /:id.
const CI_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT summary AS ci_summary, sentiment, competitive_intel,
           products_discussed AS ci_products, transcript AS ci_transcript
    FROM customer_interactions
    WHERE session_id = CONCAT('npc_', COALESCE(npc.conference_name, npc.id::text))
    ORDER BY created_at DESC
    LIMIT 1
  ) ci ON true
`;

// FTS expression — MUST match the GIN index idx_npc_fts in server/db.js exactly.
// Also referenced by server/lib/ask-nucleus.js search_my_calls tool.
// If changed here, update those two places or the index silently stops being used.
const FTS_EXPR = `to_tsvector('english',
  COALESCE(npc.ai_summary,'') || ' ' || COALESCE(npc.notes,'') || ' ' ||
  COALESCE(npc.lead_name,'') || ' ' || COALESCE(npc.lead_company,''))`;

// hasSummary filter — uses EXISTS subquery so count and data queries share the
// same WHERE clause without needing a LATERAL JOIN on the count query.
const HAS_SUMMARY_FRAGMENT = `(
  npc.ai_summary IS NOT NULL
  OR npc.notes IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM customer_interactions
    WHERE session_id = CONCAT('npc_', COALESCE(npc.conference_name, npc.id::text))
      AND summary IS NOT NULL
  )
)`;

// GET /api/history — list past calls with FTS, filters, role-based access.
// bearerOrSession (cookie for web, Authorization: Bearer for native iOS) —
// returns enriched AI/sentiment/competitive data via LATERAL JOIN. Not safe
// for unscoped API key callers. Non-admins forced to own calls.
router.get('/', bearerOrSession, rbac('external_caller'), async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { q, disposition, qualification, from, to } = req.query;
  const hasSummary = req.query.hasSummary === 'true';

  // Access control: non-admin forced to own calls
  let callerFilter = req.query.caller || null;
  if (req.user.role !== 'admin') {
    callerFilter = req.user.identity;
  }

  const where = [`npc.status = 'completed'`];
  const params = [];
  let idx = 1;

  if (callerFilter) {
    where.push(`npc.caller_identity = $${idx++}`);
    params.push(callerFilter);
  }
  if (disposition) {
    where.push(`npc.disposition = $${idx++}`);
    params.push(disposition);
  }
  if (qualification) {
    where.push(`npc.qualification = $${idx++}`);
    params.push(qualification);
  }
  if (from) {
    where.push(`npc.created_at >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    where.push(`npc.created_at <= $${idx++}`);
    params.push(to);
  }
  if (q && q.trim()) {
    where.push(`${FTS_EXPR} @@ plainto_tsquery('english', $${idx++})`);
    params.push(q.trim());
  }
  if (hasSummary) {
    where.push(HAS_SUMMARY_FRAGMENT);
  }

  const whereClause = where.join(' AND ');

  try {
    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT ${LIST_COLUMNS}, ci.ci_summary, ci.sentiment, ci.competitive_intel, ci.ci_products
         FROM nucleus_phone_calls npc
         ${CI_LATERAL}
         WHERE ${whereClause}
         ORDER BY npc.created_at DESC, npc.id DESC
         LIMIT $${idx++} OFFSET $${idx}`,
        [...params, limit, offset]
      ),
      // Count query shares the WHERE clause but needs NO JOIN — hasSummary uses
      // EXISTS subquery, and no other filter references ci.* columns.
      pool.query(
        `SELECT COUNT(*) FROM nucleus_phone_calls npc WHERE ${whereClause}`,
        params
      ),
    ]);

    res.json({
      calls: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error('History fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/history/:id/timeline — cross-channel interaction history for this contact.
// Ownership enforced via parent call 404 gate before calling lookupCustomer.
router.get('/:id/timeline', bearerOrSession, rbac('external_caller'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  const where = ['id = $1'];
  const params = [id];
  if (req.user.role !== 'admin') {
    where.push('caller_identity = $2');
    params.push(req.user.identity);
  }

  try {
    const { rows } = await pool.query(
      `SELECT lead_phone, lead_email, hubspot_contact_id, lead_company, lead_name, conference_name
       FROM nucleus_phone_calls WHERE ${where.join(' AND ')}`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Call not found' });

    const call = rows[0];
    const history = await lookupCustomer({
      phone: call.lead_phone,
      email: call.lead_email,
      contactId: call.hubspot_contact_id,
      company: call.lead_company,
      name: call.lead_name,
    });

    // Exclude the current call's own session_id from the timeline
    const currentSessionId = `npc_${call.conference_name || id}`;
    const interactions = (history?.interactions || []).filter(
      (i) => i.sessionId !== currentSessionId
    );

    res.json({ interactions });
  } catch (err) {
    console.error('Timeline fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch timeline' });
  }
});

// GET /api/history/:id — single call detail with enrichment.
// bearerOrSession (cookie for web, Authorization: Bearer for native iOS).
// Ownership enforced for non-admins.
router.get('/:id', bearerOrSession, rbac('external_caller'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  const where = ['npc.id = $1'];
  const params = [id];
  if (req.user.role !== 'admin') {
    where.push(`npc.caller_identity = $${params.length + 1}`);
    params.push(req.user.identity);
  }

  try {
    const result = await pool.query(
      `SELECT ${DETAIL_COLUMNS}, ci.ci_summary, ci.sentiment, ci.competitive_intel,
              ci.ci_products, ci.ci_transcript
       FROM nucleus_phone_calls npc
       ${CI_LATERAL}
       WHERE ${where.join(' AND ')}`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('History detail failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch call detail' });
  }
});

// POST /api/history/:id/disposition — set disposition + notes + optional follow-up email.
// Three-way auth (bearer || api-key || session) so iOS dialer, web, and automation
// can all save dispositions. Ownership check applies when req.user.identity is set
// (bearer + session paths); api-key callers bypass via the synthetic admin principal.
router.post('/:id/disposition', bearerOrApiKeyOrSession, rbac('external_caller'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  const { disposition, qualification, notes, products_discussed, send_follow_up, lead_email } = req.body;

  if (!disposition) {
    return res.status(400).json({ error: 'disposition required' });
  }

  try {
    // Ownership check (session auth only — API key callers are trusted)
    if (req.user && req.user.role !== 'admin') {
      const owner = await pool.query(
        'SELECT caller_identity FROM nucleus_phone_calls WHERE id = $1',
        [id]
      );
      if (!owner.rows.length) {
        return res.status(404).json({ error: 'Call not found' });
      }
      if (owner.rows[0].caller_identity !== req.user.identity) {
        return res.status(403).json({ error: 'Not authorized to modify this call' });
      }
    }

    const result = await pool.query(
      `UPDATE nucleus_phone_calls
       SET disposition = $1, qualification = $2, notes = $3,
           products_discussed = $4
       WHERE id = $5
       RETURNING ${CALL_COLUMNS}`,
      [
        disposition,
        qualification || null,
        notes || null,
        JSON.stringify(products_discussed || []),
        id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const call = result.rows[0];

    // Slack alert for hot/warm leads (async, non-blocking)
    if (qualification === 'hot' || qualification === 'warm') {
      const alert = formatCallAlert({
        disposition, qualification, notes,
        leadName: call.lead_name,
        leadCompany: call.lead_company,
        callerIdentity: call.caller_identity,
        durationSeconds: call.duration_seconds,
        productsDiscussed: products_discussed,
      });

      track(
        sendSlackAlert(alert)
          .then((sent) => {
            if (sent) {
              return pool.query('UPDATE nucleus_phone_calls SET slack_notified = TRUE WHERE id = $1', [call.id]);
            }
          })
          .catch((err) => console.error('Slack alert failed:', err.message))
      );
    }

    // Sync to HubSpot — add note to contact timeline (async, non-blocking)
    if (call.hubspot_contact_id) {
      const noteBody = [
        `📞 Outbound call by ${call.caller_identity}`,
        `Duration: ${formatDuration(call.duration_seconds)}`,
        `Disposition: ${disposition}${qualification ? ` (${qualification})` : ''}`,
        ...(products_discussed?.length ? [`Products: ${products_discussed.join(', ')}`] : []),
        ...(notes ? [`Notes: ${notes}`] : []),
      ].join('\n');

      track(
        addNoteToContact(call.hubspot_contact_id, noteBody)
          .then(() => {
            return pool.query('UPDATE nucleus_phone_calls SET hubspot_synced = TRUE WHERE id = $1', [call.id]);
          })
          .catch((err) => console.error('HubSpot sync failed:', err.message))
      );
    }

    // Sync to customer_interactions — include AI data if available
    const aiSummary = call.ai_summary || null;
    const aiItems = call.ai_action_items || null;
    track(
      syncInteraction({
        channel: 'voice',
        direction: 'outbound',
        sessionId: `npc_${call.conference_name || call.id}`,
        phone: call.lead_phone,
        contactName: call.lead_name,
        companyName: call.lead_company,
        agentName: call.caller_identity,
        recordingUrl: call.recording_url,
        transcript: call.transcript || null,
        summary: aiSummary || notes || '',
        productsDiscussed: aiItems?.products_discussed?.length
          ? aiItems.products_discussed : (products_discussed || []),
        disposition: qualification === 'hot' ? 'qualified_hot'
          : qualification === 'warm' ? 'qualified_warm'
          : disposition,
        qualification: qualification
          ? { stage: qualification, score: qualification === 'hot' ? 90 : 60 }
          : undefined,
        sentiment: aiItems?.objections_raised?.length
          ? { overall: 'mixed', objections: aiItems.objections_raised } : null,
        competitiveIntel: aiItems?.equipment_mentioned?.length
          ? { equipment: aiItems.equipment_mentioned } : null,
      }).catch(err => console.error('Interaction sync failed:', err.message))
    );

    // ── Follow-up email from rep's mailbox ────────────────────────
    let emailResult = {};
    // API key auth has no req.user — email sending requires session auth
    const repEmail = req.user?.email;

    if (send_follow_up && repEmail && !call.follow_up_email_sent) {
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      let resolvedEmail = lead_email;
      if (!resolvedEmail && call.hubspot_contact_id) {
        try {
          const contact = await getContact(call.hubspot_contact_id);
          resolvedEmail = contact?.properties?.email;
        } catch (err) {
          console.warn('[email] HubSpot email lookup failed:', err.message);
        }
      }

      const validEmail = resolvedEmail && EMAIL_RE.test(resolvedEmail);
      if (validEmail) {
        await pool.query('UPDATE nucleus_phone_calls SET lead_email = $1 WHERE id = $2', [resolvedEmail, id]);
      }

      if (validEmail) {
        try {
          await sendFollowUpEmail({
            fromEmail: repEmail,
            toEmail: resolvedEmail,
            leadName: call.lead_name,
            leadCompany: call.lead_company,
            products: products_discussed,
            callerIdentity: call.caller_identity,
            qualification: qualification || 'info_only',
          });
          await pool.query('UPDATE nucleus_phone_calls SET follow_up_email_sent = TRUE WHERE id = $1', [id]);
          emailResult = { email_sent: true };
        } catch (err) {
          console.error('[email] Follow-up failed:', err.message);
          await pool.query(
            'UPDATE nucleus_phone_calls SET follow_up_email_error = $1 WHERE id = $2',
            [err.message.substring(0, 500), id]
          ).catch(e => console.error('Failed to save email error:', e.message));
          emailResult = { email_sent: false, email_error: err.message };
        }
      }
    }

    // Re-fetch the row with ci.* fields via LATERAL JOIN so the client can merge
    // into the list without a refetch (prevents stale list rows after first save).
    const enrichedResult = await pool.query(
      `SELECT ${LIST_COLUMNS}, ci.ci_summary, ci.sentiment, ci.competitive_intel, ci.ci_products
       FROM nucleus_phone_calls npc
       ${CI_LATERAL}
       WHERE npc.id = $1`,
      [id]
    );
    const enriched = enrichedResult.rows[0] || call;

    res.json({ ...enriched, ...emailResult });
  } catch (err) {
    console.error('Disposition save failed:', err.message);
    res.status(500).json({ error: 'Failed to save disposition' });
  }
});

module.exports = router;
