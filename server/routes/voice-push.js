const { Router } = require('express');
const { pool } = require('../db');
const { isInteractiveCaller } = require('../middleware/auth');
const { logEvent } = require('../lib/debug-log');
const { resolveCredentialSid, CredentialUnavailableError } = require('../lib/twilio-push-binding');

const router = Router();

// Apple VoIP push tokens are hex-encoded device tokens. 64 chars (32 bytes) is
// the historical norm but Apple has explicitly told developers not to assume
// length — accept 32–256 hex chars, case-insensitive. Stricter than that risks
// rejecting valid future-format tokens; looser risks DB pollution from typos.
const PUSH_TOKEN_RE = /^[0-9a-fA-F]{32,256}$/;
const VALID_ENVIRONMENTS = new Set(['production', 'sandbox']);

// POST /api/voice-push/register
// Body: { pushToken: string (hex), environment: 'production' | 'sandbox' }
//
// Gated on isInteractiveCaller (session or bearer). API-key callers are rejected
// — push-token registration is inherently per-device-per-user, not an automation
// operation. Letting a leaked shared secret bind tokens against arbitrary user
// identities would be a privilege-escalation footgun.
router.post('/register', async (req, res, next) => {
  try {
    if (!isInteractiveCaller(req)) {
      return res.status(403).json({ error: 'Push registration requires user auth (bearer or session)' });
    }

    const { pushToken, environment } = req.body || {};

    if (typeof pushToken !== 'string' || !PUSH_TOKEN_RE.test(pushToken)) {
      return res.status(400).json({ error: 'pushToken must be a hex string (32–256 chars)' });
    }
    if (!VALID_ENVIRONMENTS.has(environment)) {
      return res.status(400).json({ error: "environment must be 'production' or 'sandbox'" });
    }

    let credentialSid;
    try {
      credentialSid = resolveCredentialSid(environment);
    } catch (err) {
      if (err instanceof CredentialUnavailableError) {
        // Sandbox credential SID is intentionally optional at boot (plan
        // line 224). A sandbox registration without the env var = the deploy
        // doesn't support sandbox tokens yet, not a client bug.
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }

    const normalizedToken = pushToken.toLowerCase();
    await pool.query(
      `INSERT INTO nucleus_phone_voip_tokens (user_id, push_token, credential_sid, environment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         push_token = EXCLUDED.push_token,
         credential_sid = EXCLUDED.credential_sid,
         environment = EXCLUDED.environment`,
      [req.user.id, normalizedToken, credentialSid, environment]
    );

    // Audit trail for credential-rotation traceability. Fire-and-forget,
    // gated on DEBUG=1. Token suffix is enough to correlate without
    // logging the full opaque device identifier.
    logEvent('state_change', 'voice-push', 'voip token registered', {
      caller: req.user.identity,
      detail: {
        environment,
        credentialSid,
        tokenSuffix: normalizedToken.slice(-8),
      },
    });

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
