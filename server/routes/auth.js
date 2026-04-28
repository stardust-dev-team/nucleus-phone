const { Router } = require('express');
const msal = require('@azure/msal-node');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { sessionAuth, SESSION_TTL_SECONDS } = require('../middleware/auth');
const { pool } = require('../db');
const { encrypt } = require('../lib/crypto');
const { verifyEntraIdToken } = require('../lib/entra-token');

const router = Router();

// Rate limits for /api/auth/exchange — applied as a chain (sustained + burst).
// Both are scoped to this route only (mounted directly on the route handler).
// Sustained: 10/min/IP. Burst: 5 per 10s/IP. Either tripping returns 429.
const exchangeSustainedLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many exchange requests' },
});
const exchangeBurstLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many exchange requests (burst)' },
});

// Look up an active user by email. Returns null if no row or is_active=false.
// This replaces the pre-e5p hardcoded USER_MAP — identity/role/display_name
// now live in nucleus_phone_users so admins can revoke or add users without
// a deploy.
async function findActiveUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT id, email, identity, role, display_name, oid
     FROM nucleus_phone_users
     WHERE email = $1 AND is_active = TRUE`,
    [email]
  );
  return rows[0] || null;
}

// Fail at boot, not at first login. A misconfigured deploy missing JWT_SECRET
// would otherwise mint tokens via `jwt.sign(payload, undefined, ...)`, which
// throws `secretOrPrivateKey must have a value` at the user — surfacing as a
// 500 with a stack trace in logs. We'd rather the process refuse to start.
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set — refusing to start auth router');
}

// Mint a nucleus_session JWT. Used by the web cookie callback and the native
// iOS bearer exchange — keep them in lockstep so secret/TTL/payload shape can
// never drift. Payload carries only userId; sessionAuth re-resolves role +
// is_active from the DB on every request (with a 5s cache).
function mintSessionToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: `${SESSION_TTL_SECONDS}s`,
  });
}

// Identity whitelist for the Twilio token endpoint — checks the DB. Cached
// briefly to avoid a round-trip on every token request during an active session.
const identityCache = { set: new Set(), at: 0 };
const IDENTITY_CACHE_TTL_MS = 60 * 1000;

async function isValidIdentity(identity) {
  if (Date.now() - identityCache.at > IDENTITY_CACHE_TTL_MS) {
    const { rows } = await pool.query(
      `SELECT identity FROM nucleus_phone_users WHERE is_active = TRUE`
    );
    identityCache.set = new Set(rows.map(r => r.identity));
    identityCache.at = Date.now();
  }
  return identityCache.set.has(identity);
}

const SCOPES = ['User.Read', 'openid', 'profile', 'email', 'Mail.Send', 'offline_access'];

let msalApp;

function getMsalApp() {
  if (!msalApp) {
    msalApp = new msal.ConfidentialClientApplication({
      auth: {
        clientId: process.env.ENTRA_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}`,
        clientSecret: process.env.ENTRA_CLIENT_SECRET,
      },
    });
  }
  return msalApp;
}

function getAppUrl() {
  return process.env.APP_URL || 'http://localhost:3001';
}

function getRedirectUri() {
  return `${getAppUrl()}/api/auth/callback`;
}

// GET /api/auth/login — redirect to Microsoft login
router.get('/login', async (req, res) => {
  try {
    const url = await getMsalApp().getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: getRedirectUri(),
    });
    res.redirect(url);
  } catch (err) {
    console.error('MSAL auth URL failed:', err.message);
    res.status(500).send('Login failed');
  }
});

// GET /api/auth/callback — Microsoft OAuth callback
router.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No auth code');

  try {
    const result = await getMsalApp().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: getRedirectUri(),
    });

    const claims = result.idTokenClaims || {};
    const email = (claims.preferred_username || claims.email || '').toLowerCase();
    const tid = claims.tid;

    // Validate tenant — must be a member of the joruva Entra tenant.
    // Note: Entra B2B guest users authenticate with their home-tenant `tid`,
    // so this check intentionally excludes guests. External users (e.g. Blake)
    // must be provisioned as cloud-only @joruva.com accounts, not B2B guests,
    // until/unless we extend this check to accept guest tokens.
    if (tid !== process.env.ENTRA_TENANT_ID) {
      return res.status(403).send('Invalid tenant');
    }

    // Look up user in the DB. The domain is no longer hard-coded — the
    // authoritative check is "does an active nucleus_phone_users row exist".
    const user = await findActiveUserByEmail(email);
    if (!user) {
      return res.status(403).send(`No active Nucleus Phone account for ${email}`);
    }

    const homeAccountId = result.account?.homeAccountId || '';

    // Persist MSAL token cache for per-rep email sending (async, non-blocking login)
    // The singleton MSAL app's cache contains ALL users who logged in during this process.
    // Strip it down to only this user's entries before storing.
    if (process.env.MSAL_ENCRYPTION_KEY) {
      const fullCache = JSON.parse(getMsalApp().getTokenCache().serialize());
      const userCache = {};
      for (const section of ['Account', 'IdToken', 'AccessToken', 'RefreshToken', 'AppMetadata']) {
        if (!fullCache[section]) continue;
        userCache[section] = {};
        for (const [key, entry] of Object.entries(fullCache[section])) {
          if (entry.home_account_id === homeAccountId || section === 'AppMetadata') {
            userCache[section][key] = entry;
          }
        }
      }
      const encrypted = encrypt(JSON.stringify(userCache));
      pool.query(
        `INSERT INTO msal_token_cache (partition_key, cache_data, home_account_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (partition_key)
         DO UPDATE SET cache_data = $2, home_account_id = $3, updated_at = NOW()`,
        [email, encrypted, homeAccountId]
      ).then(() => console.log(`[auth] MSAL cache persisted for ${email}`))
       .catch(err => console.error(`[auth] Failed to persist MSAL cache for ${email}:`, err.message));
    }

    const token = mintSessionToken(user.id);

    res.cookie('nucleus_session', token, {
      httpOnly: true,
      secure: getAppUrl().startsWith('https'),
      sameSite: 'lax',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });

    res.redirect('/');
  } catch (err) {
    console.error('MSAL token exchange failed:', err.message);
    res.status(500).send('Authentication failed');
  }
});

// GET /api/auth/me — return current user from session cookie
router.get('/me', sessionAuth, (req, res) => {
  res.json(req.user);
});

// GET /api/auth/email-ready — check if rep has MSAL tokens for email sending
router.get('/email-ready', sessionAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM msal_token_cache WHERE partition_key = $1',
      [req.user.email]
    );
    res.json({ ready: rows.length > 0 });
  } catch (err) {
    console.error('email-ready check failed:', err.message);
    res.json({ ready: false });
  }
});

// POST /api/auth/logout — clear session cookie
router.post('/logout', (req, res) => {
  res.clearCookie('nucleus_session');
  res.json({ ok: true });
});

// POST /api/auth/exchange — native iOS dialer trades a Microsoft id_token for
// the same 30-day nucleus_session JWT the web client uses (returned in the
// response body, not as a cookie). The token is meant to be sent as
// `Authorization: Bearer <jwt>` on subsequent calls — the consumer middleware
// (`bearerAuth`) lands in nucleus-phone-8sq. Until that ships, the token is
// a valid JWT but no API route will accept it.
//
// Kill-switch: ENABLE_NATIVE_EXCHANGE must be 'true' or this route returns 503.
// The check runs before rate-limiting so a disabled route doesn't consume
// rate-limit budget. Flipping the env var requires a Render redeploy (~3min) —
// the flag is a kill-switch, not a runtime toggle.
function nativeExchangeKillSwitch(req, res, next) {
  if (process.env.ENABLE_NATIVE_EXCHANGE !== 'true') {
    return res.status(503).json({ error: 'Native exchange disabled' });
  }
  next();
}

router.post('/exchange', nativeExchangeKillSwitch, exchangeSustainedLimiter, exchangeBurstLimiter, async (req, res, next) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'idToken required' });
    }

    let claims;
    try {
      claims = await verifyEntraIdToken(idToken);
    } catch (err) {
      // jsonwebtoken / jwks failures all collapse to 401 — clients can't recover
      // by retrying, and the specific reason isn't useful to leak to a caller.
      console.warn('[auth/exchange] id_token verify failed:', err.message);
      return res.status(401).json({ error: 'Invalid id_token' });
    }

    const user = await findActiveUserByEmail(claims.email);
    if (!user) {
      return res.status(403).json({ error: `No active Nucleus Phone account for ${claims.email}` });
    }

    // Stamp oid on first authenticated request. If a row already has an oid
    // and the incoming claim differs, refuse — that means the email got
    // re-mapped to a different Entra principal (admin merged accounts,
    // mailbox handed off) and silently overwriting the column would let
    // whoever logs in last take over the row. Force admin intervention.
    //
    // Compare case-insensitively. pg returns lowercase canonical UUIDs, but
    // Microsoft's oid claim has been inconsistent across token versions. A
    // single uppercase response would lock out every existing user on their
    // next login.
    if (user.oid === null) {
      try {
        await pool.query(
          `UPDATE nucleus_phone_users SET oid = $1 WHERE id = $2`,
          [claims.oid, user.id]
        );
      } catch (err) {
        if (err.code === '23505') {
          // unique_violation — another row already claims this oid
          console.error('[auth/exchange] oid collision', { email: claims.email, oid: claims.oid });
          return res.status(409).json({ error: 'oid already bound to another account' });
        }
        throw err;
      }
    } else if (user.oid.toLowerCase() !== claims.oid.toLowerCase()) {
      console.error('[auth/exchange] oid mismatch on existing row', {
        email: claims.email,
        storedOid: user.oid,
        claimedOid: claims.oid,
      });
      return res.status(409).json({ error: 'oid mismatch — contact admin' });
    }

    const token = mintSessionToken(user.id);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        identity: user.identity,
        role: user.role,
        displayName: user.display_name,
      },
      expiresAt: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = Object.assign(router, { isValidIdentity, findActiveUserByEmail });
