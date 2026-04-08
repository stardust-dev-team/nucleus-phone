/**
 * routes/apollo-webhook.js — Receives async phone number delivery from Apollo.
 *
 * When we call /people/match with reveal_phone_number=true, Apollo sends
 * the phone number asynchronously to this webhook. We update the matching
 * contact row in v35_pb_contacts.
 *
 * No auth middleware — Apollo doesn't send auth headers. We validate
 * the payload shape and require an Apollo person ID that exists in our DB.
 */

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

// POST /api/apollo/phone-webhook — Apollo sends phone numbers here
router.post('/', async (req, res) => {
  try {
    // Log raw payload for webhook delivery validation (Phase 0b)
    console.log('Apollo webhook raw:', JSON.stringify(req.body).substring(0, 500));

    const body = req.body;

    // Apollo webhook payload contains the person object with phone_numbers
    const person = body?.person || body;
    const apolloId = person?.id;
    const phoneNumbers = person?.phone_numbers;

    if (!apolloId || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      // Log for debugging but return 200 — don't make Apollo retry
      console.warn('Apollo phone webhook: no actionable data', {
        hasId: !!apolloId,
        phoneCount: phoneNumbers?.length || 0,
      });
      return res.json({ received: true, updated: 0 });
    }

    // Pick the best phone number (sanitized, direct preferred)
    const directPhone = phoneNumbers.find(p => p.type === 'direct' || p.type === 'mobile');
    const phone = directPhone?.sanitized_number
      || directPhone?.number
      || phoneNumbers[0]?.sanitized_number
      || phoneNumbers[0]?.number;

    if (!phone) {
      return res.json({ received: true, updated: 0 });
    }

    // Update the contact in v35_pb_contacts by matching on Apollo person data.
    // We match by email (most reliable) since we stored email during reveal.
    const email = person.email;
    const name = person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim();

    let updated = 0;

    if (email) {
      const result = await pool.query(
        `UPDATE v35_pb_contacts
         SET phone = $1
         WHERE email = $2 AND source = 'apollo' AND phone IS NULL
         RETURNING id`,
        [phone, email],
      );
      updated = result.rowCount;
    }

    // Fallback: match by name + source if email didn't match
    if (updated === 0 && name) {
      const result = await pool.query(
        `UPDATE v35_pb_contacts
         SET phone = $1
         WHERE full_name = $2 AND source = 'apollo' AND phone IS NULL
         RETURNING id`,
        [phone, name],
      );
      updated = result.rowCount;
    }

    if (updated > 0) {
      console.log(`Apollo phone webhook: updated ${updated} contact(s) — ${name || email} → ${phone}`);
    } else {
      console.warn('Apollo phone webhook: UNMATCHED — no contact row updated', {
        apolloId, email, name, phone,
      });
    }

    res.json({ received: true, updated });
  } catch (err) {
    console.error('Apollo phone webhook error:', err.message);
    // Return 200 — don't make Apollo retry on our errors
    res.json({ received: true, error: err.message });
  }
});

module.exports = router;
