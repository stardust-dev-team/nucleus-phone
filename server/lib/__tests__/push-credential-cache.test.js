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

  test('expired entries miss and are evicted', () => {
    cache._reset(50); // 50ms TTL for fast test
    cache.set(1, 'CRprod123');
    expect(cache.get(1)).toBe('CRprod123');
    expect(cache._size()).toBe(1);

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get(1)).toBeUndefined();
        expect(cache._size()).toBe(0);
        resolve();
      }, 60);
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

  test('set on existing user_id refreshes TTL', () => {
    cache._reset(50);
    cache.set(1, 'CRold');
    return new Promise((resolve) => {
      setTimeout(() => {
        cache.set(1, 'CRnew');
        // Should still be present after another 30ms (well within new TTL)
        setTimeout(() => {
          expect(cache.get(1)).toBe('CRnew');
          resolve();
        }, 30);
      }, 30);
    });
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
