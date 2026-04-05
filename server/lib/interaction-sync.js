/**
 * lib/interaction-sync.js — Post-interaction sync to customer_interactions.
 * DB-only module: validates, looks up prior contact, upserts row.
 *
 * Stripped from joruva-ucil/src/lib/interaction-sync.js.
 * Removed: HubSpot upsert, deal creation, Slack structured logging.
 * nucleus-phone's history.js handles HubSpot + Slack directly.
 */

const { pool } = require('../db');
const { normalizePhone } = require('./phone');
const { lookupCustomer } = require('./customer-lookup');

const VALID_CHANNELS = ['voice', 'chatbot', 'sms', 'email'];

async function syncInteraction(payload) {
  if (!payload.channel || !VALID_CHANNELS.includes(payload.channel)) {
    const err = new Error(`syncInteraction: channel must be one of ${VALID_CHANNELS.join(', ')}, got '${payload.channel}'`);
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!payload.sessionId) {
    const err = new Error('syncInteraction: sessionId is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  // Look up prior interactions for existing contact_id
  let priorContactId = null;
  try {
    const prior = await lookupCustomer({
      phone: payload.phone,
      email: payload.email,
    });
    if (prior) priorContactId = prior.contactId;
  } catch (err) {
    console.warn('Prior lookup failed, continuing without:', err.message);
  }

  // Upsert into customer_interactions (includes Phase 8 intelligence columns)
  const result = await pool.query(`
    INSERT INTO customer_interactions (
      contact_id, email, phone, company_name, contact_name, channel, session_id,
      direction, agent_name, recording_url, voice_id, intent, products_discussed,
      sizing_data, qualification, source_metadata, summary, transcript,
      disposition, next_action, sentiment, competitive_intel, slack_notified
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
    ON CONFLICT (session_id, channel) DO UPDATE SET
      contact_id = COALESCE(EXCLUDED.contact_id, customer_interactions.contact_id),
      email = COALESCE(EXCLUDED.email, customer_interactions.email),
      phone = COALESCE(EXCLUDED.phone, customer_interactions.phone),
      company_name = COALESCE(EXCLUDED.company_name, customer_interactions.company_name),
      contact_name = COALESCE(EXCLUDED.contact_name, customer_interactions.contact_name),
      agent_name = COALESCE(EXCLUDED.agent_name, customer_interactions.agent_name),
      recording_url = COALESCE(EXCLUDED.recording_url, customer_interactions.recording_url),
      voice_id = COALESCE(EXCLUDED.voice_id, customer_interactions.voice_id),
      intent = COALESCE(EXCLUDED.intent, customer_interactions.intent),
      products_discussed = CASE WHEN EXCLUDED.products_discussed = '[]'::jsonb THEN customer_interactions.products_discussed ELSE EXCLUDED.products_discussed END,
      sizing_data = CASE WHEN EXCLUDED.sizing_data = '{}'::jsonb THEN customer_interactions.sizing_data ELSE EXCLUDED.sizing_data END,
      qualification = CASE WHEN EXCLUDED.qualification = '{}'::jsonb THEN customer_interactions.qualification ELSE EXCLUDED.qualification END,
      source_metadata = EXCLUDED.source_metadata,
      summary = COALESCE(EXCLUDED.summary, customer_interactions.summary),
      transcript = COALESCE(EXCLUDED.transcript, customer_interactions.transcript),
      disposition = COALESCE(EXCLUDED.disposition, customer_interactions.disposition),
      next_action = COALESCE(EXCLUDED.next_action, customer_interactions.next_action),
      sentiment = COALESCE(EXCLUDED.sentiment, customer_interactions.sentiment),
      competitive_intel = COALESCE(EXCLUDED.competitive_intel, customer_interactions.competitive_intel),
      slack_notified = EXCLUDED.slack_notified
    RETURNING id, contact_id
  `, [
    priorContactId,
    payload.email ? payload.email.toLowerCase() : null,
    normalizePhone(payload.phone),
    payload.companyName || null,
    payload.contactName || null,
    payload.channel,
    payload.sessionId,
    payload.direction || 'inbound',
    payload.agentName || null,
    payload.recordingUrl || null,
    payload.voiceId || null,
    payload.intent || null,
    JSON.stringify(payload.productsDiscussed || []),
    JSON.stringify(payload.sizingData || {}),
    JSON.stringify(payload.qualification || {}),
    JSON.stringify(payload.sourceMetadata || {}),
    payload.summary || null,
    payload.transcript || null,
    payload.disposition || null,
    payload.nextAction || null,
    payload.sentiment ? JSON.stringify(payload.sentiment) : null,
    payload.competitiveIntel ? JSON.stringify(payload.competitiveIntel) : null,
    false,
  ]);

  if (!result.rows.length) throw new Error('syncInteraction: INSERT returned no rows');

  return {
    interactionId: result.rows[0].id,
    contactId: result.rows[0].contact_id,
  };
}

module.exports = { syncInteraction };
