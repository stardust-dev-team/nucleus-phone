/**
 * persona-defaults.test.js — pins `personaDefaultsFor` longest-match
 * dispatch against ~10 real titles. Without these tests, any future
 * PERSONA_DEFAULTS key addition (or rename) could silently re-bucket
 * existing titles and shift LTV anchors on the iOS cockpit card.
 *
 * Add a row when adding a new persona key OR when a new title pattern
 * surfaces in production data.
 */

const {
  personaDefaultsFor,
  PERSONA_DEFAULTS,
  GENERIC_PERSONA_DEFAULT,
} = require('../compressor-catalog');

describe('personaDefaultsFor — longest-match dispatch', () => {
  test.each([
    // [title, expected persona key | null for GENERIC, defaultHp anchor]
    ['VP Operations',                  'operations',     30],
    ['Director of Operations',         'operations',     30],
    ['Operations Manager',             'operations',     30],
    ['Plant Manager',                  'plant',          25],
    ['Maintenance Supervisor',         'maintenance',    15],
    ['Director of Maintenance',        'maintenance',    15],
    ['Director of Quality',            'quality',        15],
    ['Purchasing Manager',             'purchasing',     30],
    ['Procurement Director',           'procurement',    30],
    ['Facilities Manager',             'facilities',     15],
    // The disambiguation that motivated longest-match: 'supply chain'
    // (12 chars) beats 'operations' (10 chars) when both substrings
    // appear in the title.
    ['Supply Chain Operations Manager','supply chain',   25],
    ['VP Supply Chain',                'supply chain',   25],
    // Bare 'Supply' doesn't match the multi-word 'supply chain' key,
    // so it falls through to GENERIC. Intentional — see comment in
    // compressor-catalog.js PERSONA_DEFAULTS.
    ['VP Supply',                      null,             15],
    // 'engineering' (11) is the substring that must appear verbatim;
    // "Engineer" alone (no 'ing') does NOT match. So "Senior Quality
    // Engineer" maps to `quality` (7 chars matched), NOT `engineering`.
    // Pins this so a future contributor doesn't shorten the key to
    // 'engineer' without realizing it widens the bucket.
    ['Senior Quality Engineer',        'quality',        15],
    ['Manufacturing Engineering Lead', 'engineering',    30],
    ['CEO',                            null,             15],
    [null,                             null,             15],
    ['',                               null,             15],
  ])('title=%j → key=%s, defaultHp=%i', (title, expectedKey, expectedHp) => {
    const result = personaDefaultsFor(title);
    expect(result.defaultHp).toBe(expectedHp);
    if (expectedKey) {
      // Verify the returned object is identity-equal to the table entry —
      // catches accidental object copying that drops fields.
      expect(result).toBe(PERSONA_DEFAULTS[expectedKey]);
    } else {
      expect(result).toBe(GENERIC_PERSONA_DEFAULT);
    }
  });
});
