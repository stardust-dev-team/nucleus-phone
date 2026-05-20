const { Router } = require('express');
const { generateAccessToken } = require('../lib/twilio');
const { isValidIdentity } = require('./auth');
const { pool } = require('../db');
const pushCredentialCache = require('../lib/push-credential-cache');

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
  // environment baked into credential_sid.
  //
  // Failure modes are FATAL (503) not silent — per Linus's 2026-05-19 review:
  // the pre-fix code silently fell through with null pushCredentialSid,
  // which is exactly the bug shape that produced APNs 52143 historically.
  // If we can't verify the user's push credential binding, we refuse to
  // issue a mobile token rather than degrade back into the broken
  // auto-pick behavior. iOS clients handle 503 in their existing 401/
  // transient-error retry path; the registration ordering at
  // VoIPPushRegistrar.swift:89 (register before token fetch) keeps the
  // success path 100%.
  let pushCredentialSid = null;
  if (incomingAllow && req.user && req.user.id && req.user.id !== 0) {
    // 30s in-process cache (nucleus-phone-84ax). Positive hits skip DB;
    // misses or expired entries fall through to the SELECT and re-cache.
    // Negative results are NOT cached so a re-register recovers instantly.
    pushCredentialSid = pushCredentialCache.get(req.user.id) || null;

    if (!pushCredentialSid) {
      // Snapshot the invalidation generation BEFORE the SELECT — Linus #2
      // race: a concurrent voice-push/register invalidate() that fires
      // between our pool.query() and our cache.set() would otherwise let
      // us write the OLD credential_sid into the cache for a full TTL.
      // setIfFresh skips the write when generation drifts.
      const gen = pushCredentialCache.getInvalidationCount(req.user.id);

      let row;
      try {
        const result = await pool.query(
          'SELECT credential_sid FROM nucleus_phone_voip_tokens WHERE user_id = $1',
          [req.user.id]
        );
        row = result.rows[0];
      } catch (err) {
        console.error('token: voip_tokens lookup failed:', err.message);
        return res.status(503).json({
          error: 'Push credential lookup failed',
          detail: 'Cannot issue mobile token without verifying push credential binding. Retry shortly.',
        });
      }
      if (!row || !row.credential_sid) {
        return res.status(503).json({
          error: 'No push credential registered',
          detail: 'POST /api/voice-push/register before requesting a mobile token.',
        });
      }
      pushCredentialSid = row.credential_sid;
      // setIfFresh is a no-op if invalidate() ran during our SELECT —
      // in that case the next token fetch pays the DB round-trip and
      // re-caches correctly. Better than serving stale credentials.
      pushCredentialCache.setIfFresh(req.user.id, pushCredentialSid, gen);
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
