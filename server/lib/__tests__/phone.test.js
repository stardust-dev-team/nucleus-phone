const { normalizePhone } = require('../phone');

describe('normalizePhone', () => {
  test('null/undefined/empty returns null', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  test('non-string returns null', () => {
    expect(normalizePhone(12345)).toBeNull();
  });

  test('strips formatting from US number', () => {
    expect(normalizePhone('(800) 555-1234')).toBe('8005551234');
  });

  test('strips leading 1 from 11-digit US number', () => {
    expect(normalizePhone('18005551234')).toBe('8005551234');
  });

  test('preserves 11+ digit international numbers not starting with 1', () => {
    expect(normalizePhone('442071234567')).toBe('442071234567');
  });

  test('too short returns null', () => {
    expect(normalizePhone('555-12')).toBeNull();
  });

  test('strips ext extension', () => {
    expect(normalizePhone('8005551234 ext 200')).toBe('8005551234');
    expect(normalizePhone('8005551234 ext. 200')).toBe('8005551234');
  });

  test('strips # extension notation', () => {
    expect(normalizePhone('8005551234#200')).toBe('8005551234');
    expect(normalizePhone('8005551234 #200')).toBe('8005551234');
  });

  test('strips x extension with preceding whitespace', () => {
    expect(normalizePhone('8005551234 x200')).toBe('8005551234');
  });

  test('bare x without whitespace is NOT stripped (avoids truncation)', () => {
    // "8005551234x" should keep the x (it gets stripped as non-digit anyway)
    // but "8005551234x5" should NOT remove x5 since there's no whitespace
    expect(normalizePhone('8005551234x5')).toBe('80055512345');
  });
});
