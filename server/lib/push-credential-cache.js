/**
 * In-process cache for /api/token's nucleus_phone_voip_tokens lookup.
 *
 * /api/token?mode=mobile hits the DB on every fetch (iOS re-fetches on
 * foreground events) just to map user_id → credential_sid. The mapping
 * changes only when a user re-registers their push token via
 * POST /api/voice-push/register — a rare event. Caching trades a 30s
 * staleness window (in the worst case, a single missed cross-environment
 * switch) for eliminating a Postgres round-trip per token fetch.
 *
 * Filed as nucleus-phone-84ax — option (a) from the 2026-05-19 Linus #8.
 *
 * Semantics:
 *  - Positive entries (credential_sid string) cached for TTL_MS.
 *  - Negative entries (no row found) are NOT cached. Re-registration must
 *    recover immediately; caching a miss would block iOS through a full
 *    TTL after the user finally registers.
 *  - voice-push/register invalidates the user_id after upsert, so an
 *    environment switch on the same process is reflected immediately on
 *    that instance. Other instances (Render runs multiple) see staleness
 *    bounded by TTL_MS.
 *  - Cache size is bounded by active rep count (fleet is small). No LRU
 *    eviction — the dataset is naturally small and re-registration writes
 *    in place rather than growing the keyspace.
 */

const DEFAULT_TTL_MS = 30 * 1000;

const cache = new Map();
let ttlMs = DEFAULT_TTL_MS;

function get(userId) {
  if (!userId) return undefined;
  const entry = cache.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(userId);
    return undefined;
  }
  return entry.credentialSid;
}

function set(userId, credentialSid) {
  if (!userId || !credentialSid) return;
  cache.set(userId, { credentialSid, expiresAt: Date.now() + ttlMs });
}

function invalidate(userId) {
  if (!userId) return;
  cache.delete(userId);
}

function _reset(newTtlMs = DEFAULT_TTL_MS) {
  cache.clear();
  ttlMs = newTtlMs;
}

function _size() {
  return cache.size;
}

module.exports = { get, set, invalidate, _reset, _size, DEFAULT_TTL_MS };
