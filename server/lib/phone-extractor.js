/**
 * phone-extractor.js — Extracts US phone numbers from real-time transcript text.
 *
 * Runs on every transcript chunk during live calls. Pure regex — no AI calls.
 * Captures numbers spoken as digits ("5 5 5 1 2 3 4 5 6 7") or naturally
 * ("five five five, one two three, four five six seven") and formats them.
 *
 * Returns normalized E.164 strings. Deduplicates against already-captured numbers
 * for the call. Ignores the call's own lead_phone to avoid self-capture.
 */

const { pool } = require('../db');

// Match 10-digit US phone patterns in transcript text:
// - Digit sequences: "5551234567", "555-123-4567", "(555) 123-4567", "555.123.4567"
// - Spaced digits from RT transcription: "5 5 5 1 2 3 4 5 6 7"
// - With optional +1 / 1 prefix
const PHONE_DIGIT_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})/g;

// Spoken digit sequences — RT transcription often outputs "5 5 5 1 2 3 4 5 6 7"
// Uses \s+ between digits to handle inconsistent spacing from transcription engines.
const SPACED_DIGITS_RE = /(?:(?:\+?1\s+)?(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d))/g;

// Toll-free and premium prefixes — not useful for outbound sales capture.
// These are real phone numbers but not direct-dial numbers worth recording.
const IGNORE_PREFIXES = new Set([
  '800', '888', '877', '866', '855', '844', '833', '822', // toll-free
  '900', '976',                                             // premium-rate
]);

function extractPhoneNumbers(text) {
  if (!text || typeof text !== 'string') return [];

  const found = new Set();

  // Standard digit patterns
  let match;
  while ((match = PHONE_DIGIT_RE.exec(text)) !== null) {
    const [, area, exchange, subscriber] = match;
    if (!IGNORE_PREFIXES.has(area)) {
      found.add(`+1${area}${exchange}${subscriber}`);
    }
  }

  // Spaced single digits (common in RT transcription)
  while ((match = SPACED_DIGITS_RE.exec(text)) !== null) {
    const digits = match.slice(1).join('');
    const area = digits.slice(0, 3);
    if (!IGNORE_PREFIXES.has(area)) {
      found.add(`+1${digits}`);
    }
  }

  return [...found];
}

/**
 * Process a transcript chunk for phone numbers and store any new ones.
 * Fire-and-forget — the caller (transcription.js) discards the return value.
 * @param {number} callDbId - The database row id of the call
 * @param {string} leadPhone - The call's lead_phone (to exclude from captures)
 * @param {string} text - Transcript chunk text
 */
async function capturePhones(callDbId, leadPhone, text) {
  const phones = extractPhoneNumbers(text);
  if (phones.length === 0) return;

  // Normalize lead_phone for comparison
  const leadDigits = leadPhone ? leadPhone.replace(/\D/g, '').slice(-10) : '';

  // Filter out the call's own lead phone
  const candidates = phones.filter(p => {
    const digits = p.replace(/\D/g, '').slice(-10);
    return digits !== leadDigits;
  });

  if (candidates.length === 0) return;

  // Atomic dedup + append — only add phones not already in the array
  await pool.query(
    `UPDATE nucleus_phone_calls
     SET captured_phones = (
       SELECT jsonb_agg(DISTINCT val)
       FROM (
         SELECT val FROM jsonb_array_elements_text(COALESCE(captured_phones, '[]'::jsonb)) AS val
         UNION
         SELECT unnest($1::text[])
       ) sub
     )
     WHERE id = $2`,
    [candidates, callDbId],
  );
}

module.exports = { extractPhoneNumbers, capturePhones };
