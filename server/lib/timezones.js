/**
 * lib/timezones.js — US state → timezone mapping for call-time filtering.
 *
 * Maps two-letter state codes to timezone groups and IANA identifiers.
 * Used by signal-contacts.js to expand a timezone filter into geo_state IN (...).
 *
 * States that span two zones use primary/majority timezone.
 * Arizona uses America/Phoenix (no DST).
 */

const TIMEZONE_GROUPS = {
  eastern:  ['CT', 'DE', 'FL', 'GA', 'IN', 'KY', 'MA', 'MD', 'ME', 'MI', 'NC', 'NH', 'NJ', 'NY', 'OH', 'PA', 'RI', 'SC', 'TN', 'VA', 'VT', 'WV', 'DC'],
  central:  ['AL', 'AR', 'IA', 'IL', 'KS', 'LA', 'MN', 'MO', 'MS', 'NE', 'ND', 'OK', 'SD', 'TX', 'WI'],
  mountain: ['AZ', 'CO', 'ID', 'MT', 'NM', 'UT', 'WY'],
  pacific:  ['CA', 'NV', 'OR', 'WA'],
  alaska:   ['AK'],
  hawaii:   ['HI'],
};

// Reverse lookup: state code → IANA timezone
const STATE_TO_IANA = {};
const IANA_BY_GROUP = {
  eastern: 'America/New_York',
  central: 'America/Chicago',
  mountain: 'America/Denver',
  pacific: 'America/Los_Angeles',
  alaska: 'America/Anchorage',
  hawaii: 'Pacific/Honolulu',
};

for (const [group, states] of Object.entries(TIMEZONE_GROUPS)) {
  const iana = IANA_BY_GROUP[group];
  for (const st of states) {
    STATE_TO_IANA[st] = iana;
  }
}
// Arizona: no DST
STATE_TO_IANA['AZ'] = 'America/Phoenix';

/**
 * Expand a timezone group name into an array of state codes.
 * @param {string} tz - 'eastern' | 'central' | 'mountain' | 'pacific' | 'alaska' | 'hawaii'
 * @returns {string[]|null} Array of state codes, or null if invalid
 */
function statesForTimezone(tz) {
  return TIMEZONE_GROUPS[tz?.toLowerCase()] || null;
}

module.exports = { TIMEZONE_GROUPS, STATE_TO_IANA, IANA_BY_GROUP, statesForTimezone };
