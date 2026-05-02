/**
 * auth.js — session + API key authentication.
 *
 * nucleus-phone-e5p changes:
 *   - JWT now carries only { userId }. Role, identity, email, and is_active
 *     come from the nucleus_phone_users row on every request.
 *   - A 5-second in-memory cache by userId keeps the DB load trivial while
 *     still giving effectively-instant revocation when an admin flips
 *     is_active = false.
 *   - Session TTL is 30 days.
 */

const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const USER_CACHE_TTL_MS = 5 * 1000;

const userCache = new Map();

function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.at > USER_CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  userCache.set(userId, { user, at: Date.now() });
}

function invalidateUser(userId) {
  userCache.delete(userId);
}

async function loadUserById(userId) {
  const cached = getCachedUser(userId);
  if (cached) return cached;
  const { rows } = await pool.query(
    `SELECT id, email, identity, role, display_name, is_active
     FROM nucleus_phone_users
     WHERE id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (!row.is_active) return null;
  const user = {
    id: row.id,
    email: row.email,
    identity: row.identity,
    role: row.role,
    displayName: row.display_name,
  };
  setCachedUser(userId, user);
  return user;
}

async function sessionAuth(req, res, next) {
  const token = req.cookies?.nucleus_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  // State-changing requests via session cookie must include a custom header.
  // HTML forms cannot set custom headers, so this blocks CSRF from same-site
  // origins (sameSite:lax already blocks cross-site).
  if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['x-requested-with']) {
    return res.status(403).json({ error: 'Missing X-Requested-With header' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }

  // Backwards-compat: accept pre-e5p tokens that carried identity/role/email
  // directly. These are still on internal users and will roll off as cookies
  // expire or users re-login. New tokens carry only userId.
  if (payload.userId) {
    try {
      const user = await loadUserById(payload.userId);
      if (!user) return res.status(401).json({ error: 'Session revoked' });
      req.user = { ...user, authSource: 'session' };
      return next();
    } catch (err) {
      console.error('[sessionAuth] user lookup failed:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  }

  if (payload.identity && payload.role && payload.email) {
    // Legacy token — resolve to current DB row by email so revocation still
    // works for pre-e5p sessions.
    try {
      const { rows } = await pool.query(
        `SELECT id, email, identity, role, display_name, is_active
         FROM nucleus_phone_users WHERE email = $1`,
        [payload.email]
      );
      if (!rows.length || !rows[0].is_active) {
        return res.status(401).json({ error: 'Session revoked' });
      }
      const row = rows[0];
      const user = {
        id: row.id,
        email: row.email,
        identity: row.identity,
        role: row.role,
        displayName: row.display_name,
      };
      setCachedUser(row.id, user);
      req.user = { ...user, authSource: 'session' };
      return next();
    } catch (err) {
      console.error('[sessionAuth] legacy lookup failed:', err.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  }

  return res.status(401).json({ error: 'Invalid session' });
}

// Bearer-token auth for native iOS dialer. Reads `Authorization: Bearer <jwt>`,
// verifies a nucleus_session JWT (post-e5p shape only — `userId` required;
// the legacy `{identity, role, email}` payload sessionAuth still accepts is
// rejected here on purpose: the dialer is brand-new, no legacy bearer tokens
// can exist in the wild). Then loads the user fresh from DB (5s cache).
// No CSRF check — bearer tokens aren't auto-attached by browsers, so XHR/CORS
// rules + token possession are the boundary. No cookie fallback — that's
// bearerOrSession's job.
async function bearerAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid bearer token' });
  }

  if (!payload.userId) {
    return res.status(401).json({ error: 'Invalid bearer token' });
  }

  try {
    const user = await loadUserById(payload.userId);
    if (!user) return res.status(401).json({ error: 'Session revoked' });
    req.user = { ...user, authSource: 'bearer' };
    return next();
  } catch (err) {
    console.error('[bearerAuth] user lookup failed:', err.message);
    return res.status(500).json({ error: 'Auth error' });
  }
}

// Composer used by routes the dialer hits AND web hits — picks bearerAuth when
// the client sent an Authorization header, sessionAuth otherwise. Order matters:
// presence of `authorization` is the discriminator, NOT presence of the cookie,
// because as of M1 the dialer's URLSession can carry legacy cookies in
// HTTPCookieStorage alongside its own bearer token. We want bearer to win in
// that case. (If a future M2+ change removes URLSession cookie storage, this
// reasoning becomes redundant, not wrong — keep the discriminator anyway.)
function bearerOrSession(req, res, next) {
  if (req.headers.authorization) return bearerAuth(req, res, next);
  return sessionAuth(req, res, next);
}

// Three-way composer: bearer → API key → session. Same precedence reasoning
// as bearerOrSession (Authorization header wins because the dialer's URLSession
// can carry legacy cookies). Falls through apiKeyAuth, which itself falls
// through to sessionAuth when x-api-key is absent. Net resolution:
//   Authorization: Bearer …  → bearerAuth   (authSource:'bearer')
//   x-api-key: …             → apiKeyAuth   (authSource:'api_key')
//   nucleus_session cookie   → sessionAuth  (authSource:'session')
//   none                     → 401 from sessionAuth
// Used on routes hit by all three callers (dialer, web, automation).
function bearerOrApiKeyOrSession(req, res, next) {
  if (req.headers.authorization) return bearerAuth(req, res, next);
  return apiKeyAuth(req, res, next);
}

// Accepts API key OR session cookie. API key callers get a synthetic admin
// principal — the key is a shared secret only given to server-side automation,
// so equating it with admin is intentional. Wrong key is a hard 401.
function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key) {
    if (key === process.env.NUCLEUS_PHONE_API_KEY) {
      // Synthetic admin principal for API-key callers (automation, n8n).
      // authSource lets downstream routes distinguish API keys from browser
      // sessions — contacts.js uses this to withhold ai_summary from API-
      // key callers even though they have admin privilege.
      req.user = {
        id: 0,
        email: 'api-key@nucleus-phone',
        identity: 'system',
        role: 'admin',
        displayName: 'API Key',
        authSource: 'api_key',
      };
      return next();
    }
    return res.status(401).json({ error: 'Invalid API key' });
  }
  return sessionAuth(req, res, next);
}

// Predicate for "interactive principal" — a real human behind a session
// cookie or a bearer token, NOT API-key automation. Routes use this to
// gate response fields that should reach humans but not n8n/scripts (e.g.
// ai_summary on contacts/cockpit). Lives here so the gate is a constraint
// instead of a comment that asks parallel sites to stay in sync.
function isInteractiveCaller(req) {
  return req.user?.authSource === 'session' || req.user?.authSource === 'bearer';
}

// Test helper — writes a user directly to the in-memory cache so integration
// tests can mock jwt.verify to return `{userId}` and skip the DB round-trip
// on sessionAuth. NOT intended for production code paths.
function __testSetUser(user) {
  setCachedUser(user.id, user);
}

module.exports = {
  apiKeyAuth,
  sessionAuth,
  bearerAuth,
  bearerOrSession,
  bearerOrApiKeyOrSession,
  isInteractiveCaller,
  loadUserById,
  invalidateUser,
  SESSION_TTL_SECONDS,
  __testSetUser,
};
