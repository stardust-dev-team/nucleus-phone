/**
 * routes/apollo-webhook.js — Receives async phone number delivery from Apollo.
 *
 * When we call /people/match with reveal_phone_number=true, Apollo sends
 * the phone number asynchronously to this webhook. We update the matching
 * contact row in v35_pb_contacts via apollo_person_id.
 *
 * Apollo webhook payload format:
 *   { status, total_requested_enrichments, people: [{ id, status, phone_numbers }] }
 * Each phone_numbers entry: { sanitized_number, raw_number, type_cd, confidence_cd, status_cd }
 *
 * No auth middleware — Apollo doesn't send auth headers.
 */

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

/**
 * Pick a direct/mobile phone from Apollo's phone_numbers array.
 * Returns { phone, type } or null. Never falls back to work/other (corporate HQ).
 */
function pickDirectPhoneWithType(phoneNumbers) {
  if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) return null;
  const direct = phoneNumbers.find(p =>
    (p.type_cd === 'mobile' || p.type_cd === 'direct' || p.type === 'mobile' || p.type === 'direct')
    && p.status_cd !== 'invalid_number',
  );
  if (!direct?.sanitized_number) return null;
  const type = direct.type_cd || direct.type || 'mobile';
  return { phone: direct.sanitized_number, type };
}

// POST /api/apollo/phone-webhook — Apollo sends phone numbers here
router.post('/', async (req, res) => {
  try {
    if (process.env.DEBUG_APOLLO_WEBHOOK) {
      console.log('Apollo webhook raw:', JSON.stringify(req.body).substring(0, 500));
    }

    const body = req.body;

    // Apollo sends { people: [{ id, phone_numbers }] }
    const people = body?.people;
    if (!Array.isArray(people) || people.length === 0) {
      console.warn('Apollo phone webhook: no people array', {
        keys: Object.keys(body || {}),
        status: body?.status,
      });
      return res.json({ received: true, updated: 0 });
    }

    let totalUpdated = 0;

    for (const entry of people) {
      const apolloId = entry.id;
      if (!apolloId) {
        console.warn('Apollo phone webhook: entry missing id, skipping');
        continue;
      }

      const phoneResult = pickDirectPhoneWithType(entry.phone_numbers);
      if (!phoneResult) {
        console.warn('Apollo phone webhook: no usable phone', { apolloId });
        continue;
      }

      // Match by apollo_person_id — the only reliable key in the webhook payload.
      // Always overwrite: sync path may have stored a corporate HQ number from sanitized_phone.
      const result = await pool.query(
        `UPDATE v35_pb_contacts
         SET phone = $1, phone_type = $2
         WHERE apollo_person_id = $3 AND source = 'apollo'
         RETURNING id`,
        [phoneResult.phone, phoneResult.type, apolloId],
      );

      if (result.rowCount > 0) {
        const row = result.rows[0];
        console.log(`Apollo phone webhook: updated contact ${row.id}`);
        totalUpdated += result.rowCount;
      } else {
        console.warn('Apollo phone webhook: UNMATCHED', { apolloId });
      }
    }

    res.json({ received: true, updated: totalUpdated });
  } catch (err) {
    console.error('Apollo phone webhook error:', err.message);
    // Signal failure so Apollo retries, but don't leak internals
    res.status(500).json({ received: false });
  }
});

module.exports = router;
