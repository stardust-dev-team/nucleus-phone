const { Router } = require('express');
const { bearerOrApiKeyOrSession, isInteractiveCaller } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');
const { searchContacts, getContact, findContactByPhone } = require('../lib/hubspot');
const { normalizePhone } = require('../lib/phone');
const { pool } = require('../db');
const { getSignalContacts, getContactsForDomain } = require('../lib/signal-contacts');
const { TIMEZONE_GROUPS } = require('../lib/timezones');

const router = Router();

// Every contact route is available to external_caller — reps need the call
// list + signal-scored contacts to do their job. Admin-only data (pipeline
// management, credit spend) lives under /api/signals instead.
router.use(bearerOrApiKeyOrSession, rbac('external_caller'));

const VALID_TIERS = new Set(['spear', 'targeted', 'awareness']);
const VALID_TIMEZONES = new Set(Object.keys(TIMEZONE_GROUPS));

// 5s in-memory phone → projection cache for /api/contacts/lookup. Keyed by the
// normalized phone string (NOT the raw query) so equivalent formats hit the
// same entry. Misses ARE cached: the iOS dialer's incoming-call path can fire
// the same lookup multiple times in quick succession (CallKit pre-display +
// retry on transcription), and a 5s wait for a brand-new HubSpot contact to
// appear is acceptable. Mirror of auth.js:17-37.
const LOOKUP_CACHE_TTL_MS = 5 * 1000;
const lookupCache = new Map();

function getCachedLookup(normalizedPhone) {
  const entry = lookupCache.get(normalizedPhone);
  if (!entry) return null;
  if (Date.now() - entry.at > LOOKUP_CACHE_TTL_MS) {
    lookupCache.delete(normalizedPhone);
    return null;
  }
  return entry.value;
}

function setCachedLookup(normalizedPhone, value) {
  lookupCache.set(normalizedPhone, { value, at: Date.now() });
}

// Project a HubSpot contact (or null) to the iOS dialer's display shape.
// Treats empty-string and null HubSpot fields as equivalent (both are "missing").
// Partial names are allowed: a contact with only firstname or only lastname
// renders that piece alone. If both are blank, name stays null and CallKit
// keeps the E.164 visible. Company is never folded into name — iOS renders
// the two fields in separate labels.
function projectContact(contact) {
  if (!contact) return { name: null, company: null, hubspotId: null };
  const p = contact.properties || {};
  const first = (p.firstname || '').trim();
  const last = (p.lastname || '').trim();
  const fullName = [first, last].filter(Boolean).join(' ') || null;
  return {
    name: fullName,
    company: (p.company || '').trim() || null,
    hubspotId: contact.id || null,
  };
}

// ── Signal-scored contacts (must be before /:id) ────────────────────

// GET /api/contacts/signal — companies with nested contacts, ordered by signal_score
// Note: timezone and geo_state are mutually exclusive. If both are sent, timezone wins
// (geo_state is ignored). This is enforced in buildSignalWhere.
router.get('/signal', async (req, res) => {
  try {
    const { signal_tier, geo_state, timezone, has_phone, limit = '50', offset = '0' } = req.query;

    if (timezone && !VALID_TIMEZONES.has(timezone)) {
      return res.status(400).json({ error: `Invalid timezone. Valid: ${[...VALID_TIMEZONES].join(', ')}` });
    }

    // signal_tier supports comma-separated values (e.g., "spear,targeted")
    let tiers;
    if (signal_tier) {
      tiers = signal_tier.split(',');
      const invalid = tiers.find(t => !VALID_TIERS.has(t));
      if (invalid) return res.status(400).json({ error: `Invalid tier: ${invalid}` });
    }

    const result = await getSignalContacts({
      signal_tier: tiers || undefined,
      geo_state: geo_state || undefined,
      timezone: timezone || undefined,
      has_phone: has_phone !== 'false', // default true
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
      // Only session-authed browser callers receive AI-generated summaries.
      // API-key callers get call metadata only. See CLAUDE.md:70.
      includeSummary: !!req.user,
    });
    res.json(result);
  } catch (err) {
    console.error('Signal contacts fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch signal contacts' });
  }
});

// GET /api/contacts/signal/:domain — all contacts at a specific signal-scored company
router.get('/signal/:domain', async (req, res) => {
  try {
    const result = await getContactsForDomain(req.params.domain, {
      includeSummary: !!req.user,
    });
    if (!result.company) return res.status(404).json({ error: 'Domain not found in reservoir' });
    res.json(result);
  } catch (err) {
    console.error('Domain contacts fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch domain contacts' });
  }
});

// ── HubSpot CRM contacts ────────────────────────────────────────────

// GET /api/contacts — search/list HubSpot contacts
router.get('/', async (req, res) => {
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
          // COALESCE preserves NULL ai_summary in array_agg ordering so that a
          // most-recent unsummarized call reports null (not a stale older summary).
          `SELECT lead_phone, hubspot_contact_id,
                  COUNT(*) as call_count,
                  MAX(created_at) as last_call,
                  (array_agg(disposition ORDER BY created_at DESC))[1] as last_disposition,
                  (array_agg(COALESCE(ai_summary, '') ORDER BY created_at DESC))[1] as last_summary
           FROM nucleus_phone_calls
           WHERE lead_phone = ANY($1) OR hubspot_contact_id = ANY($2)
           GROUP BY lead_phone, hubspot_contact_id`,
          [phones, contactIds.map(String)]
        );

        // Sensitive AI data (lastSummary) is only exposed to session-authed
        // browser callers, matching the /api/history policy at CLAUDE.md:70.
        // API-key callers (e.g. n8n, external tools) get call metadata only.
        // Interactive callers (session + bearer) get full response;
        // API-key automation is the only caller withheld from ai_summary.
        const includeSummary = isInteractiveCaller(req);

        for (const row of result.rows) {
          const key = row.hubspot_contact_id || row.lead_phone;
          callHistory[key] = {
            callCount: parseInt(row.call_count, 10),
            lastCall: row.last_call,
            lastDisposition: row.last_disposition,
            ...(includeSummary && { lastSummary: row.last_summary || null }),
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

// GET /api/contacts/lookup?phone=<e164> — phone-to-contact lookup for the iOS
// dialer's incoming-call display. Returns { name, company, hubspotId } so
// CallKit can live-update the call display from "+14802221234" to "Tom Russo
// — Acme" within ~500ms on cache hits.
//
// Contract:
//   - 200 with all-null fields on miss (no HubSpot match) — iOS treats this
//     as "phone known, contact unknown" and keeps the E.164 on the lock screen.
//   - 200 with projected fields on hit.
//   - 400 if phone is missing or normalizes to null (invalid format).
//   - 500 on HubSpot/network failure (NOT cached, so next call retries).
//
// Caching: 5s TTL, keyed on the normalized phone, hits AND misses cached.
// Caller-side (iOS) has its own short cache; this server cache exists to
// protect the HubSpot rate limit when multiple reps' devices look up the
// same inbound call (e.g. round-robin distribution).
//
// MUST be registered BEFORE the '/:id' route below — the numeric-id validator
// would otherwise 400 on '/lookup'.
router.get('/lookup', async (req, res) => {
  const phone = req.query.phone;
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ error: 'phone query param required' });
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'phone must be a valid E.164 number' });
  }

  const cached = getCachedLookup(normalized);
  if (cached) return res.json(cached);

  try {
    const contact = await findContactByPhone(phone);
    const projected = projectContact(contact);
    setCachedLookup(normalized, projected);
    res.json(projected);
  } catch (err) {
    console.error('Contact lookup failed:', err);
    res.status(500).json({ error: 'Failed to look up contact' });
  }
});

// GET /api/contacts/:id — single contact detail
router.get('/:id', async (req, res) => {
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
