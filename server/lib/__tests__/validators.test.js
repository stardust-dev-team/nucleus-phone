const { isValidEmail, EMAIL_MAX_LEN } = require('../validators');

describe('isValidEmail', () => {
  describe('valid inputs', () => {
    test.each([
      ['minimal shape',  'a@b.co'],
      ['common shape',   'jane@acme.com'],
      ['plus addressing', 'jane+sales@acme.com'],
      ['subdomain',      'jane@mail.acme.com'],
      ['mixed case',     'Jane@Acme.Com'],
      ['numeric local',  '12345@acme.com'],
    ])('%s', (_, input) => expect(isValidEmail(input)).toBe(true));

    test('exactly EMAIL_MAX_LEN chars is valid (boundary)', () => {
      // 249 + `@` + `b.co` = 254 chars
      const exactly254 = `${'a'.repeat(249)}@b.co`;
      expect(exactly254.length).toBe(EMAIL_MAX_LEN);
      expect(isValidEmail(exactly254)).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    test.each([
      ['null',                null],
      ['undefined',           undefined],
      ['empty string',        ''],
      ['number',              42],
      ['object',              { email: 'jane@acme.com' }],
      ['no `@`',              'janeacme.com'],
      ['no domain dot',       'jane@acme'],
      ['leading whitespace',  ' jane@acme.com'],
      ['trailing whitespace', 'jane@acme.com '],
      ['internal whitespace', 'jane @acme.com'],
      ['just `@`',            '@'],
      ['no local part',       '@acme.com'],
      ['no domain part',      'jane@'],
      ['multiple `@`',        'jane@@acme.com'],
    ])('%s', (_, input) => expect(isValidEmail(input)).toBe(false));

    test('one char over EMAIL_MAX_LEN is invalid (boundary)', () => {
      const oversize = `${'a'.repeat(250)}@b.co`; // 255
      expect(oversize.length).toBe(EMAIL_MAX_LEN + 1);
      expect(isValidEmail(oversize)).toBe(false);
    });

    test('huge string with valid shape is rejected by length cap', () => {
      const huge = `${'a'.repeat(10_000)}@b.co`;
      expect(isValidEmail(huge)).toBe(false);
    });
  });
});
