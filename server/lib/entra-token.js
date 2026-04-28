/**
 * entra-token.js — verify Microsoft Entra (Azure AD) v2.0 id_tokens.
 *
 * Used by POST /api/auth/exchange to validate id_tokens minted by the native
 * iOS dialer's Entra app. We accept ONLY v2.0 tokens (issuer ends in `/v2.0`)
 * for the configured tenant + dialer client ID.
 *
 * JWKS keys are cached + rate-limited by jwks-rsa to avoid hammering Microsoft
 * on every request. A 10-minute cache + 10/min fetch limit is the upstream
 * recommended posture.
 */

const jwt = require('jsonwebtoken');

// jwks-rsa is required lazily (inside getJwksClient) instead of at module top.
// Why: it transitively pulls in `jose`, which is ESM-only. The server Jest
// config has no babel transform — adding one just to handle this transitive
// dep would slow down 800+ existing tests. Lazy-requiring keeps the cost
// scoped to "production code that actually verifies a token." Tests that
// mock verifyEntraIdToken or never call it pay nothing.
//
// Trade-off: a second ESM-only dep in the future has to do the same dance.
// If that happens, revisit by adding `transformIgnorePatterns` + a server
// babel transform.
let jwksClient;
let _client;

function getJwksClient() {
  if (_client) return _client;
  const tenantId = process.env.ENTRA_TENANT_ID;
  if (!tenantId) {
    throw new Error('ENTRA_TENANT_ID not configured');
  }
  if (!jwksClient) jwksClient = require('jwks-rsa');
  _client = jwksClient({
    jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    cache: true,
    // Long enough to dodge the JWKS endpoint on every login; short enough to
    // pick up emergency rotations within ~10 min.
    cacheMaxAge: 10 * 60 * 1000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
  return _client;
}

function getSigningKey(header, callback) {
  getJwksClient().getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

/**
 * Verify a Microsoft Entra v2.0 id_token.
 *
 * Throws if signature is invalid, claims fail, or the token is expired.
 * On success returns { email, oid, name }.
 *
 * Strict claim checks:
 *   • iss === https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0
 *     (rejects v1 `sts.windows.net/...` tokens — different audience semantics)
 *   • aud === ENTRA_DIALER_CLIENT_ID (only the dialer's app may exchange)
 *   • tid === ENTRA_TENANT_ID (single-tenant Joruva — no B2B guests)
 *   • exp not past (jsonwebtoken enforces by default)
 */
function verifyEntraIdToken(idToken) {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const audience = process.env.ENTRA_DIALER_CLIENT_ID;
  if (!tenantId) throw new Error('ENTRA_TENANT_ID not configured');
  if (!audience) throw new Error('ENTRA_DIALER_CLIENT_ID not configured');

  const expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      getSigningKey,
      {
        algorithms: ['RS256'],
        issuer: expectedIssuer,
        audience,
      },
      (err, payload) => {
        if (err) return reject(err);
        if (payload.tid !== tenantId) {
          return reject(new Error(`tid mismatch: expected ${tenantId}, got ${payload.tid}`));
        }
        const email = (payload.preferred_username || payload.email || '').toLowerCase();
        if (!email) return reject(new Error('id_token missing preferred_username/email claim'));
        if (!payload.oid) return reject(new Error('id_token missing oid claim'));
        resolve({
          email,
          oid: payload.oid,
          name: payload.name || null,
        });
      }
    );
  });
}

module.exports = { verifyEntraIdToken };
