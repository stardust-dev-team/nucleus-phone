/**
 * equipment-details-schema.test.js — Validates DETAILS entries in seed-equipment-specs.js
 * have consistent shape. Catches missing fields on future entries before they hit the DB.
 */

const path = require('path');
const { DETAILS } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'seed-equipment-specs.js'));

const REQUIRED_FIELDS = [
  'description',
  'typical_applications',
  'industries',
  'air_usage_notes',
  'recommended_compressor',
  'recommended_dryer',
];

const OPTIONAL_FIELDS = [
  'common_air_problems',
  'recommended_air_quality',
  'recommended_filters',
  'system_notes',
  'key_selling_points',
  'common_objections',
];

const ARRAY_FIELDS = [
  'typical_applications',
  'industries',
  'common_air_problems',
  'recommended_filters',
  'key_selling_points',
  'common_objections',
];

const keys = Object.keys(DETAILS);

describe('seed-equipment-specs DETAILS schema', () => {
  test('DETAILS has at least 20 entries', () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(keys)('%s', (key) => {
    const entry = DETAILS[key];

    test.each(REQUIRED_FIELDS)('has required field: %s', (field) => {
      expect(entry).toHaveProperty(field);
      expect(entry[field]).toBeTruthy();
    });

    test('key format is Manufacturer:Model', () => {
      expect(key).toMatch(/^[A-Z][^:]+:.+$/);
    });

    test('array fields are arrays when present', () => {
      for (const field of ARRAY_FIELDS) {
        if (entry[field] != null) {
          expect(Array.isArray(entry[field])).toBe(true);
        }
      }
    });

    test('has no unexpected fields', () => {
      const allowed = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
      for (const field of Object.keys(entry)) {
        expect(allowed.has(field)).toBe(true);
      }
    });
  });
});
