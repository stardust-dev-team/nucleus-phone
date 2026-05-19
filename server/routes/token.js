const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');
const { isValidIdentity } = require('./auth');
const { pool } = require('../db');

const router = Router();

router.get('/', async (req, res) => {
  // Session auth: identity ALWAYS comes from req.user — a logged-in caller
  // cannot request a Twilio token for a different identity. This prevents
  // Blake from generating tokens as Kate even if he knows her identity string.
  //
  // API key auth: identity comes from query param. The API key is a shared
  // server-to-server secret and is trusted to act as any identity.
  let identity;
  if (req.user && req.user.id !== 0) {
    identity = req.user.identity;
  } else {
    identity = req.query.identity;
  }

  if (!identity) {
    return res.status(400).json({ error: 'identity required' });
  }

  try {
    if (!(await isValidIdentity(identity))) {
      return res.status(403).json({ error: 'Invalid identity' });
    }
  } catch (err) {
    console.error('Identity validation failed:', err.message);
    return res.status(500).json({ error: 'Identity validation failed' });
  }

  // ?mode=mobile opts the token into incomingAllow:true so the native iOS
  // dialer can receive TVOCallInvite via PushKit. PWA continues to call
  // without the param (default incomingAllow:false).
  const incomingAllow = req.query.mode === 'mobile';

  // For mobile tokens, look up the user's most-recently-registered push
  // environment in nucleus_phone_voip_tokens and bind the VoiceGrant to the
  // matching credential. Without this, Twilio auto-picks a credential at
  // TwilioVoiceSDK.register() time (in this account that meant the legacy
  // Flex APN credential — wrong cert → APNs error 52143 on every push).
  //
  // The lookup keys off req.user.id, which is only meaningful for real
  // logged-in callers. API-key callers (req.user.id === 0) and unauth
  // callers skip the lookup. The iOS dialer ALWAYS hits /api/voice-push/register
  // before /api/token?mode=mobile (VoIPPushRegistrar.register(hex:) at
  // dialer-mac/NucleusPhone/PushKit/VoIPPushRegistrar.swift:86-144), so by
  // the time we read the table, the row exists with the device's current
  // environment baked into credential_sid. If the row is missing for some
  // reason (race, fresh user, env mismatch), we fall through with null —
  // Twilio's default picker takes over and the call may not deliver, but
  // the grant generation itself succeeds.
  let pushCredentialSid = null;
  if (incomingAllow && req.user && req.user.id && req.user.id !== 0) {
    try {
      const { rows } = await pool.query(
        'SELECT credential_sid FROM nucleus_phone_voip_tokens WHERE user_id = $1',
        [req.user.id]
      );
      pushCredentialSid = rows[0]?.credential_sid || null;
    } catch (err) {
      console.error('token: voip_tokens lookup failed:', err.message);
      // Non-fatal — fall through with null pushCredentialSid.
    }
  }

  try {
    // Only forward pushCredentialSid when we actually have one — keeps the
    // generateAccessToken call signature byte-identical for PWA / API-key /
    // legacy callers, so existing tests pinning the call shape don't break.
    const opts = { incomingAllow };
    if (pushCredentialSid) opts.pushCredentialSid = pushCredentialSid;
    const token = generateAccessToken(identity, opts);
    res.json({ token, identity });
  } catch (err) {
    console.error('Token generation failed:', err);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

module.exports = router;
