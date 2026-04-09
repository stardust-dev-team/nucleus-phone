const { Router } = require('express');
const { apiKeyAuth } = require('../middleware/auth');
const { searchContacts, getContact } = require('../lib/hubspot');
const { pool } = require('../db');
const { getSignalContacts, getContactsForDomain } = require('../lib/signal-contacts');

const router = Router();

// ── Signal-scored contacts (must be before /:id) ────────────────────

// GET /api/contacts/signal — companies with nested contacts, ordered by signal_score
router.get('/signal', apiKeyAuth, async (req, res) => {
  try {
    const { signal_tier, geo_state, timezone, has_phone, limit = '50', offset = '0' } = req.query;
    const result = await getSignalContacts({
      signal_tier: signal_tier || undefined,
      geo_state: geo_state || undefined,
      timezone: timezone || undefined,
      has_phone: has_phone !== 'false', // default true
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
    });
    res.json(result);
  } catch (err) {
    console.error('Signal contacts fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch signal contacts' });
  }
});

// GET /api/contacts/signal/:domain — all contacts at a specific signal-scored company
router.get('/signal/:domain', apiKeyAuth, async (req, res) => {
  try {
    const result = await getContactsForDomain(req.params.domain);
    if (!result.company) return res.status(404).json({ error: 'Domain not found in reservoir' });
    res.json(result);
  } catch (err) {
    console.error('Domain contacts fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch domain contacts' });
  }
});

// ── HubSpot CRM contacts ────────────────────────────────────────────

// GET /api/contacts — search/list HubSpot contacts
router.get('/', apiKeyAuth, async (req, res) => {
  const { q, limit = 50, after } = req.query;

  try {
    const hsResult = await searchContacts(q || '', parseInt(limit, 10), after || undefined);
    const contacts = hsResult.results || [];

    // Enrich with call history from our database
    if (contacts.length > 0) {
      const phones = contacts
        .map((c) => c.properties.phone || c.properties.mobilephone)
        .filter(Boolean);

      const contactIds = contacts.map((c) => c.id).filter(Boolean);

      let callHistory = {};
      if (phones.length > 0 || contactIds.length > 0) {
        const result = await pool.query(
          `SELECT lead_phone, hubspot_contact_id,
                  COUNT(*) as call_count,
                  MAX(created_at) as last_call,
                  (array_agg(disposition ORDER BY created_at DESC))[1] as last_disposition
           FROM nucleus_phone_calls
           WHERE lead_phone = ANY($1) OR hubspot_contact_id = ANY($2)
           GROUP BY lead_phone, hubspot_contact_id`,
          [phones, contactIds.map(String)]
        );

        for (const row of result.rows) {
          const key = row.hubspot_contact_id || row.lead_phone;
          callHistory[key] = {
            callCount: parseInt(row.call_count, 10),
            lastCall: row.last_call,
            lastDisposition: row.last_disposition,
          };
        }
      }

      // Attach call history to each contact
      for (const contact of contacts) {
        const phone = contact.properties.phone || contact.properties.mobilephone;
        contact.callHistory = callHistory[contact.id] || callHistory[phone] || null;
      }
    }

    res.json({
      contacts,
      paging: hsResult.paging || null,
    });
  } catch (err) {
    console.error('Contacts fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/contacts/:id — single contact detail
router.get('/:id', apiKeyAuth, async (req, res) => {
  const id = req.params.id;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id must be numeric' });
  }

  try {
    const contact = await getContact(id);

    // Get full call history for this contact
    const calls = await pool.query(
      `SELECT id, created_at, caller_identity, duration_seconds, disposition,
              qualification, notes, products_discussed
       FROM nucleus_phone_calls
       WHERE hubspot_contact_id = $1 OR lead_phone = $2
       ORDER BY created_at DESC LIMIT 20`,
      [id, contact.properties.phone || '']
    );

    contact.callHistory = calls.rows;
    res.json(contact);
  } catch (err) {
    console.error('Contact fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

module.exports = router;
