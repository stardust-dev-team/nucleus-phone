const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const VoiceResponse = twilio.twiml.VoiceResponse;

// incomingAllow controls whether Twilio will deliver TVOCallInvite events to
// this token's bearer. PWA callers don't take inbound (default false). The
// native iOS dialer needs incomingAllow:true so PushKit + CallKit can receive
// TVOCallInvite — caller opts in via routes/token.js (?mode=mobile).
//
// pushCredentialSid binds TwilioVoiceSDK.register() to a specific APN
// credential. Without it, Twilio auto-picks (in this account that meant the
// legacy Flex APN credential whose cert was minted for a different bundle —
// APNs error 52143 "device token does not match topic" on every <Client>
// push). Caller passes the SID matching the iOS build's environment:
// TWILIO_VOICE_PUSH_CREDENTIAL_SID for Release builds (aps-environment:
// production), TWILIO_VOICE_PUSH_CREDENTIAL_SID_SANDBOX for Debug builds.
// PWA callers omit it.
function generateAccessToken(identity, { incomingAllow = false, pushCredentialSid = null } = {}) {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );

  const grantOpts = {
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow,
  };
  if (pushCredentialSid) grantOpts.pushCredentialSid = pushCredentialSid;
  const grant = new VoiceGrant(grantOpts);

  token.addGrant(grant);
  return token.toJwt();
}

module.exports = { client, VoiceResponse, generateAccessToken };
