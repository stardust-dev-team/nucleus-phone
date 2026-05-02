const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');
const { isValidIdentity } = require('./auth');

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

  try {
    const token = generateAccessToken(identity, { incomingAllow });
    res.json({ token, identity });
  } catch (err) {
    console.error('Token generation failed:', err);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

module.exports = router;
