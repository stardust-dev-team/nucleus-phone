/**
 * Tests for the /api/token push-credential cache (nucleus-phone-84ax).
 *
 * Pure unit tests against the cache module — token.test.js covers the
 * integration where the cache lives on the request path.
 */

const cache = require('../push-credential-cache');

beforeEach(() => {
  cache._reset();
});

describe('push-credential-cache', () => {
  test('miss returns undefined', () => {
    expect(cache.get(1)).toBeUndefined();
  });

  test('positive set/get hits within TTL', () => {
    cache.set(1, 'CRprod123');
    expect(cache.get(1)).toBe('CRprod123');
  });

  test('different user_ids isolated', () => {
    cache.set(1, 'CRone');
    cache.set(2, 'CRtwo');
    expect(cache.get(1)).toBe('CRone');
    expect(cache.get(2)).toBe('CRtwo');
  });

  // Fake clock, not real sleeps: a wall-clock setTimeout race flaked under the full suite (jsec-oo8u). The module reads
  // Date.now(), which jest's modern fake timers control.
  describe('with a fake clock', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test('expired entries miss and are evicted', () => {
      cache._reset(50);
      cache.set(1, 'CRprod123');
      expect(cache.get(1)).toBe('CRprod123');
      expect(cache._size()).toBe(1);

      jest.advanceTimersByTime(49);
      expect(cache.get(1)).toBe('CRprod123');   // one ms inside the TTL: still a hit
      jest.advanceTimersByTime(1);
      expect(cache.get(1)).toBeUndefined();     // expiresAt <= now: expired at exactly the TTL
      expect(cache._size()).toBe(0);
    });

    test('set on existing user_id refreshes TTL', () => {
      cache._reset(50);
      cache.set(1, 'CRold');                    // would expire at t=50
      jest.advanceTimersByTime(30);
      cache.set(1, 'CRnew');                    // refreshed: expires at t=80
      jest.advanceTimersByTime(30);             // t=60: past the OLD expiry, inside the new one
      expect(cache.get(1)).toBe('CRnew');
      jest.advanceTimersByTime(20);             // t=80: expires at refresh-time + TTL, not old-expiry + TTL
      expect(cache.get(1)).toBeUndefined();
    });
  });

  test('invalidate clears a specific entry', () => {
    cache.set(1, 'CRone');
    cache.set(2, 'CRtwo');
    cache.invalidate(1);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.get(2)).toBe('CRtwo');
  });

  test('falsy user_ids are no-ops', () => {
    cache.set(0, 'CRzero');
    cache.set(null, 'CRnull');
    cache.set(undefined, 'CRundef');
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(null)).toBeUndefined();
    expect(cache.get(undefined)).toBeUndefined();
    expect(cache._size()).toBe(0);
  });

  test('falsy credentialSid is not cached', () => {
    cache.set(1, null);
    cache.set(1, '');
    expect(cache.get(1)).toBeUndefined();
    expect(cache._size()).toBe(0);
  });
});

// Linus pass #2 (invalidation-set race). getInvalidationCount + setIfFresh
// guard against the order:
//   T1: tokenFetch.gen = getInvalidationCount(uid)
//   T2: tokenFetch.SELECT old_sid (suspends on await)
//   T3: register: UPSERT new_sid; invalidate(uid) → gen++
//   T4: tokenFetch resumes; setIfFresh(uid, OLD_sid, T1_gen) → skipped
// The cache stays empty (not poisoned with OLD_sid); next fetch goes to
// DB and re-caches the new_sid.
describe('setIfFresh / getInvalidationCount race guard', () => {
  test('setIfFresh writes when generation matches snapshot', () => {
    const gen = cache.getInvalidationCount(1);
    expect(gen).toBe(0);
    const wrote = cache.setIfFresh(1, 'CRfresh', gen);
    expect(wrote).toBe(true);
    expect(cache.get(1)).toBe('CRfresh');
  });

  test('setIfFresh skips when invalidate ran between snapshot and write', () => {
    const gen = cache.getInvalidationCount(1);
    cache.invalidate(1);  // simulates concurrent register
    const wrote = cache.setIfFresh(1, 'CRstale', gen);
    expect(wrote).toBe(false);
    expect(cache.get(1)).toBeUndefined();  // not poisoned
  });

  test('getInvalidationCount increments per invalidate', () => {
    expect(cache.getInvalidationCount(1)).toBe(0);
    cache.invalidate(1);
    expect(cache.getInvalidationCount(1)).toBe(1);
    cache.invalidate(1);
    expect(cache.getInvalidationCount(1)).toBe(2);
  });

  test('generation counter is per-user (unrelated invalidations do not block)', () => {
    const gen1 = cache.getInvalidationCount(1);
    cache.invalidate(2);  // bumps user 2 only
    const wrote = cache.setIfFresh(1, 'CRok', gen1);
    expect(wrote).toBe(true);
    expect(cache.get(1)).toBe('CRok');
  });

  test('falsy user_id or empty sid is a no-op (no crash)', () => {
    expect(cache.setIfFresh(null, 'CR', 0)).toBe(false);
    expect(cache.setIfFresh(0, 'CR', 0)).toBe(false);
    expect(cache.setIfFresh(1, '', 0)).toBe(false);
    expect(cache.setIfFresh(1, null, 0)).toBe(false);
  });

  test('_reset clears invalidation counters too', () => {
    cache.invalidate(1);
    cache.invalidate(1);
    expect(cache.getInvalidationCount(1)).toBe(2);
    cache._reset();
    expect(cache.getInvalidationCount(1)).toBe(0);
  });
});
