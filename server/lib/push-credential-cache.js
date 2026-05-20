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
 *
 * Invalidation-set race (Linus pass #2):
 *  Callers MUST use the getInvalidationCount + setIfFresh dance, not the
 *  raw set(). Without it, this race is open:
 *    1. Token-fetch starts, cache.get → miss
 *    2. Token-fetch awaits pool.query
 *    3. voice-push/register completes UPSERT + invalidate(userId)
 *    4. Token-fetch's pool.query resumes with the OLD credential_sid
 *    5. Token-fetch's set() writes the OLD value, sticking around for
 *       up to TTL_MS until the next register or expiry.
 *  The generation counter is per-user, incremented on invalidate. The
 *  caller snapshots it at SELECT start; setIfFresh writes only if the
 *  generation is unchanged. Raced sets silently skip — next token fetch
 *  pays the DB round-trip and re-caches correctly.
 */

const DEFAULT_TTL_MS = 30 * 1000;

const cache = new Map();
const invalidations = new Map();  // userId -> monotonic counter
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

/**
 * Snapshot the invalidation generation for a user. Pair with setIfFresh
 * after a DB load so a concurrent invalidate during the load is detected
 * and the stale-value write is skipped.
 */
function getInvalidationCount(userId) {
  if (!userId) return 0;
  return invalidations.get(userId) || 0;
}

/**
 * Race-safe set. Writes only if the per-user generation matches the
 * snapshot taken before the SELECT — otherwise an invalidate raced us
 * and our DB result is presumed stale.
 */
function setIfFresh(userId, credentialSid, expectedGeneration) {
  if (!userId || !credentialSid) return false;
  const current = invalidations.get(userId) || 0;
  if (current !== expectedGeneration) return false;  // raced
  cache.set(userId, { credentialSid, expiresAt: Date.now() + ttlMs });
  return true;
}

/**
 * Raw set — no race guard. Kept for tests that want to seed cache state
 * directly. Production callers should use setIfFresh.
 */
function set(userId, credentialSid) {
  if (!userId || !credentialSid) return;
  cache.set(userId, { credentialSid, expiresAt: Date.now() + ttlMs });
}

function invalidate(userId) {
  if (!userId) return;
  invalidations.set(userId, (invalidations.get(userId) || 0) + 1);
  cache.delete(userId);
}

function _reset(newTtlMs = DEFAULT_TTL_MS) {
  cache.clear();
  invalidations.clear();
  ttlMs = newTtlMs;
}

function _size() {
  return cache.size;
}

module.exports = {
  get,
  set,
  setIfFresh,
  invalidate,
  getInvalidationCount,
  _reset,
  _size,
  DEFAULT_TTL_MS,
};
