const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');
const { VALID_IDENTITIES } = require('./auth');

const router = Router();

router.get('/', (req, res) => {
  // Session auth: identity comes from JWT (already validated at login).
  // API key auth: identity comes from query param, validated against whitelist.
  // Defense-in-depth: validate against whitelist regardless of auth method.
  const identity = req.user?.identity || req.query.identity;
  if (!identity) {
    return res.status(400).json({ error: 'identity required' });
  }

  if (!VALID_IDENTITIES.has(identity)) {
    return res.status(403).json({ error: 'Invalid identity' });
  }

  try {
    const token = generateAccessToken(identity);
    res.json({ token, identity });
  } catch (err) {
    console.error('Token generation failed:', err);
    res.status(500).json({ error: 'Token generation failed' });
  }
});

module.exports = router;
