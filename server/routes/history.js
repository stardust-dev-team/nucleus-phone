const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { pool } = require('../db');
const { sendSlackAlert, formatCallAlert } = require('../lib/slack');
const { addNoteToContact, getContact } = require('../lib/hubspot');
const { formatDuration } = require('../lib/format');
const { syncInteraction } = require('../lib/interaction-sync');
const { sendFollowUpEmail } = require('../lib/email-sender');

const router = Router();

// SAFETY: CALL_COLUMNS is a compile-time constant, never user input
const CALL_COLUMNS = `id, created_at, conference_name, caller_identity, lead_phone,
  lead_name, lead_company, hubspot_contact_id, direction, status, duration_seconds,
  disposition, qualification, products_discussed, notes, recording_url,
  recording_duration, fireflies_uploaded, lead_email, follow_up_email_sent,
  follow_up_email_error`;

// GET /api/history — list past calls
router.get('/', apiKeyAuth, async (req, res) => {
  const { caller, disposition } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let where = ['status = \'completed\''];
  const params = [];
  let idx = 1;

  if (caller) {
    where.push(`caller_identity = $${idx++}`);
    params.push(caller);
  }
  if (disposition) {
    where.push(`disposition = $${idx++}`);
    params.push(disposition);
  }

  const whereClause = where.join(' AND ');

  try {
    const result = await pool.query(
      `SELECT ${CALL_COLUMNS} FROM nucleus_phone_calls
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      [...params, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM nucleus_phone_calls WHERE ${whereClause}`,
      params
    );

    res.json({
      calls: result.rows,
      total: parseInt(countResult.rows[0].count, 10),
    });
  } catch (err) {
    console.error('History fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/history/:id — single call detail
router.get('/:id', apiKeyAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  try {
    const result = await pool.query(
      `SELECT ${CALL_COLUMNS} FROM nucleus_phone_calls WHERE id = $1`,
      [id]
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

// POST /api/history/:id/disposition — set disposition + notes
router.post('/:id/disposition', apiKeyAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: 'id must be an integer' });
  }

  const { disposition, qualification, notes, products_discussed, send_follow_up, lead_email } = req.body;

  if (!disposition) {
    return res.status(400).json({ error: 'disposition required' });
  }

  try {
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

      sendSlackAlert(alert)
        .then((sent) => {
          if (sent) {
            pool.query('UPDATE nucleus_phone_calls SET slack_notified = TRUE WHERE id = $1', [call.id])
              .catch((err) => console.error('Failed to update slack_notified flag:', err.message));
          }
        })
        .catch((err) => console.error('Slack alert failed:', err.message));
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

      addNoteToContact(call.hubspot_contact_id, noteBody)
        .then(() => {
          pool.query('UPDATE nucleus_phone_calls SET hubspot_synced = TRUE WHERE id = $1', [call.id])
            .catch((err) => console.error('Failed to update hubspot_synced flag:', err.message));
        })
        .catch((err) => console.error('HubSpot sync failed:', err.message));
    }

    // Sync to customer_interactions (async, non-blocking)
    syncInteraction({
      channel: 'voice',
      direction: 'outbound',
      sessionId: `npc_${call.conference_name || call.id}`,
      phone: call.lead_phone,
      contactName: call.lead_name,
      companyName: call.lead_company,
      agentName: call.caller_identity,
      recordingUrl: call.recording_url,
      summary: notes || '',
      productsDiscussed: products_discussed || [],
      disposition: qualification === 'hot' ? 'qualified_hot'
        : qualification === 'warm' ? 'qualified_warm'
        : disposition,
      qualification: qualification
        ? { stage: qualification, score: qualification === 'hot' ? 90 : 60 }
        : undefined,
    }).catch(err => console.error('Interaction sync failed:', err.message));

    // ── Follow-up email from rep's mailbox ────────────────────────
    let emailResult = {};
    const repEmail = req.user?.email;

    if (send_follow_up && repEmail && !call.follow_up_email_sent) {
      // Basic email validation
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // Resolve lead email: request body → HubSpot lookup
      let resolvedEmail = lead_email;
      if (!resolvedEmail && call.hubspot_contact_id) {
        try {
          const contact = await getContact(call.hubspot_contact_id);
          resolvedEmail = contact?.properties?.email;
        } catch (err) {
          console.warn('[email] HubSpot email lookup failed:', err.message);
        }
      }

      // Always save lead_email for auditability
      if (resolvedEmail) {
        await pool.query('UPDATE nucleus_phone_calls SET lead_email = $1 WHERE id = $2', [resolvedEmail, id])
          .catch(err => console.error('Failed to save lead_email:', err.message));
      }

      if (resolvedEmail && EMAIL_RE.test(resolvedEmail)) {
        try {
          await sendFollowUpEmail({
            fromEmail: repEmail,
            toEmail: resolvedEmail,
            leadName: call.lead_name,
            leadCompany: call.lead_company,
            products: products_discussed,
            notes,
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

    res.json({ ...call, ...emailResult });
  } catch (err) {
    console.error('Disposition save failed:', err.message);
    res.status(500).json({ error: 'Failed to save disposition' });
  }
});

module.exports = router;
