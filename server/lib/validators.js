// Shared input validators. One source of truth so tightening (e.g., banned
// TLDs, IDN-aware matching) touches one file instead of three.

// RFC 5321 §4.5.3.1.3 — full address path is capped at 254 octets.
const EMAIL_MAX_LEN = 254;

// Shape-only check: rejects whitespace, requires a single `@` and a `.` in
// the domain. Cannot catch shaped-right typos (e.g., `jane@acme.con`); use
// upstream verification for that.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= EMAIL_MAX_LEN
    && EMAIL_RE.test(value);
}

module.exports = { isValidEmail, EMAIL_MAX_LEN };
