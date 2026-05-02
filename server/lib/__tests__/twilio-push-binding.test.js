// nucleus-phone-zht.3: env → push credential SID resolver

const { resolveCredentialSid, CredentialUnavailableError } = require('../twilio-push-binding');

describe('resolveCredentialSid', () => {
  const PROD = 'CRprod_____________________________';
  const SANDBOX = 'CRsandbox__________________________';

  beforeEach(() => {
    delete process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID;
    delete process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX;
  });

  test('production returns TWILIO_VOICE_PUSH_CREDENTIAL_SID', () => {
    process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID = PROD;
    expect(resolveCredentialSid('production')).toBe(PROD);
  });

  test('sandbox returns TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX', () => {
    process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX = SANDBOX;
    expect(resolveCredentialSid('sandbox')).toBe(SANDBOX);
  });

  test('throws CredentialUnavailableError when sandbox env is unset', () => {
    expect(() => resolveCredentialSid('sandbox')).toThrow(CredentialUnavailableError);
  });

  test('throws CredentialUnavailableError when production env is unset', () => {
    expect(() => resolveCredentialSid('production')).toThrow(CredentialUnavailableError);
  });

  test('treats whitespace-only env var as unset', () => {
    process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID = '   ';
    expect(() => resolveCredentialSid('production')).toThrow(CredentialUnavailableError);
  });

  test('throws on unknown environment string', () => {
    expect(() => resolveCredentialSid('staging')).toThrow(/Unknown environment/);
  });

  test('trims surrounding whitespace from env value', () => {
    process.env.TWILIO_VOICE_PUSH_CREDENTIAL_SID = `  ${PROD}\n`;
    expect(resolveCredentialSid('production')).toBe(PROD);
  });
});
