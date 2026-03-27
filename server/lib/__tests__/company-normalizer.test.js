const { normalizeCompanyName, normalizeForWaterfall, generateVariants } = require('../company-normalizer');

describe('normalizeCompanyName', () => {
  test('empty/null returns empty string', () => {
    expect(normalizeCompanyName(null)).toBe('');
    expect(normalizeCompanyName('')).toBe('');
  });

  test('lowercases and strips common suffixes', () => {
    expect(normalizeCompanyName('Acme Corp.')).toBe('acme');
    expect(normalizeCompanyName('Widgets Inc')).toBe('widgets');
    expect(normalizeCompanyName('Big Co LLC')).toBe('big co');
  });

  test('strips trailing punctuation', () => {
    expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
  });
});

describe('normalizeForWaterfall', () => {
  test('empty/null returns empty string', () => {
    expect(normalizeForWaterfall(null)).toBe('');
  });

  test('decodes HTML entities', () => {
    expect(normalizeForWaterfall('Smith &amp; Wesson Corp')).toBe('smith & wesson');
    expect(normalizeForWaterfall('O&#39;Brien Ltd')).toBe("o'brien");
  });

  test('strips leading "the"', () => {
    expect(normalizeForWaterfall('The Boeing Company')).toBe('boeing');
  });

  test('strips stacked suffixes (international + domestic)', () => {
    expect(normalizeForWaterfall('Siemens AG Corp.')).toBe('siemens');
  });

  test('collapses whitespace', () => {
    expect(normalizeForWaterfall('  Acme   Corp  ')).toBe('acme');
  });
});

describe('generateVariants', () => {
  test('empty/null returns empty array', () => {
    expect(generateVariants(null)).toEqual([]);
    expect(generateVariants('')).toEqual([]);
  });

  test('& generates "and" variant', () => {
    const v = generateVariants('Smith & Wesson');
    expect(v).toContain('smith & wesson');
    expect(v).toContain('smith and wesson');
  });

  test('"and" generates & variant', () => {
    const v = generateVariants('Johnson and Johnson');
    expect(v).toContain('johnson and johnson');
    expect(v).toContain('johnson & johnson');
  });

  test('no & or "and" returns single variant', () => {
    const v = generateVariants('Acme Corp');
    expect(v).toEqual(['acme']);
  });
});
