// nucleus-phone-zht.3: resolves the Twilio Voice push credential SID a token
// should be associated with at registration time. Path B — the iOS SDK handles
// the actual binding via TwilioVoiceSDK.register(); the server stores the SID
// for audit + credential-rotation fan-out.
//
// Sandbox is intentionally a runtime concern, not a boot one: the prod deploy
// must start even though TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX is unset
// (per plan line 224 — sandbox deferred until Phase H2 dev-device testing).
// Registration with environment='sandbox' fails fast with a 503-mappable error
// only when an actual sandbox token is offered.

const ENV_VAR = {
  production: 'TWILIO_VOICE_PUSH_CREDENTIAL_SID',
  sandbox: 'TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX',
};

class CredentialUnavailableError extends Error {
  constructor(environment) {
    super(`No push credential configured for environment="${environment}" (expected ${ENV_VAR[environment]})`);
    this.name = 'CredentialUnavailableError';
    this.environment = environment;
  }
}

function resolveCredentialSid(environment) {
  const key = ENV_VAR[environment];
  if (!key) throw new Error(`Unknown environment: ${environment}`);
  const sid = process.env[key];
  if (!sid || !sid.trim()) throw new CredentialUnavailableError(environment);
  return sid.trim();
}

module.exports = { resolveCredentialSid, CredentialUnavailableError };
