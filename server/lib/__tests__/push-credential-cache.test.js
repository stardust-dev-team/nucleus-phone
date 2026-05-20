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
