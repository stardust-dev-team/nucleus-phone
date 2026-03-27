const { formatDuration } = require('../format');

describe('formatDuration', () => {
  test('null returns 0:00', () => expect(formatDuration(null)).toBe('0:00'));
  test('undefined returns 0:00', () => expect(formatDuration(undefined)).toBe('0:00'));
  test('0 returns 0:00', () => expect(formatDuration(0)).toBe('0:00'));
  test('65 seconds is 1:05', () => expect(formatDuration(65)).toBe('1:05'));
  test('3600 seconds is 60:00', () => expect(formatDuration(3600)).toBe('60:00'));
  test('pads single-digit seconds', () => expect(formatDuration(9)).toBe('0:09'));
});
