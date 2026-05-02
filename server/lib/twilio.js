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
function generateAccessToken(identity, { incomingAllow = false } = {}) {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
    incomingAllow,
  });

  token.addGrant(grant);
  return token.toJwt();
}

module.exports = { client, VoiceResponse, generateAccessToken };
