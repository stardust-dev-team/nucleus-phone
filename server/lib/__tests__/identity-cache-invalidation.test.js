/**
 * identity-cache-invalidation.test.js — event-driven identity cache invalidation
 * (joruva-ucil-jno).
 *
 * The resolver caches identities in-process for CACHE_TTL_MS. That is a TIME-based
 * cache with no reaction to upstream change: when a rep fixes a name in HubSpot, the
 * cockpit keeps serving the old one until the entry expires.
 *
 * These cover the invalidation path. The cache is keyed by IDENTIFIER, not by
 * contact — one person occupies a phone key, an email key and a hubspot-id key at
 * once — so the interesting failure is a PARTIAL invalidation: fresh data when looked
 * up one way, stale the other, with nothing to indicate which you got.
 */

jest.mock('../identity-resolver-inline', () => ({
  resolve: jest.fn(),
  toE164: (digits) => (digits ? (digits.length === 10 ? `+1${digits}` : `+${digits}`) : null),
}));

describe('identity cache invalidation (joruva-ucil-jno)', () => {
  const realFetch = global.fetch;
  let resolver;
  let inline;

  const HUB_CONTACT = {
    found: true,
    contact: {
      first_name: 'Jane', last_name: 'Doe',
      email: 'jane@acme.com', phone: '+16025550100',
      title: 'Ops Manager', company_name: 'Acme',
    },
  };

  beforeEach(() => {
    jest.resetModules();
    process.env.HUB_ADMIN_EMAIL = 'nucleus-phone@joruva.com';
    process.env.HUB_ADMIN_KEY = 'test-key';
    process.env.UCIL_HUB_URL = 'https://hub.test';
    delete process.env.USE_HUB_RESOLVER;
    inline = require('../identity-resolver-inline');
    inline.resolve.mockReset();
    resolver = require('../identity-resolver');
    resolver.clearCache();

    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, json: async () => HUB_CONTACT,
    }));
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Warm the cache for an identifier and confirm it is actually warm. */
  async function warm(identifier) {
    await resolver.resolve(identifier);
    const callsAfterFirst = global.fetch.mock.calls.length;
    await resolver.resolve(identifier);
    expect(global.fetch.mock.calls.length).toBe(callsAfterFirst);
    return callsAfterFirst;
  }

  it('a warm entry is served without calling the hub again', async () => {
    const calls = await warm('+16025550100');
    expect(calls).toBeGreaterThan(0);
  });

  it('invalidating by phone forces the next lookup back to the hub', async () => {
    const calls = await warm('+16025550100');

    const dropped = resolver.invalidateContact({ phone_normalized: '+16025550100' });
    expect(dropped.length).toBe(1);

    await resolver.resolve('+16025550100');
    expect(global.fetch.mock.calls.length).toBe(calls + 1);
  });

  it('invalidating by email forces the next lookup back to the hub', async () => {
    const calls = await warm('jane@acme.com');

    expect(resolver.invalidateContact({ email: 'jane@acme.com' }).length).toBe(1);

    await resolver.resolve('jane@acme.com');
    expect(global.fetch.mock.calls.length).toBe(calls + 1);
  });

  /**
   * THE ONE THAT MATTERS. The same person is cached under several keys. An event
   * carrying all of them must clear all of them — dropping only the phone would leave
   * the cockpit fresh by phone and stale by email, and no caller can tell which
   * lookup path it took.
   */
  it('clears every identifier the event carries, not just the first', async () => {
    await resolver.resolve('+16025550100');
    await resolver.resolve('jane@acme.com');
    const warmCalls = global.fetch.mock.calls.length;

    const dropped = resolver.invalidateContact({
      phone_normalized: '+16025550100',
      email: 'jane@acme.com',
    });
    expect(dropped.length).toBe(2);

    await resolver.resolve('+16025550100');
    await resolver.resolve('jane@acme.com');
    expect(global.fetch.mock.calls.length).toBe(warmCalls + 2);
  });

  it('reports only the keys it actually dropped', async () => {
    await warm('+16025550100');

    // The email was never cached, so it is not a drop.
    const dropped = resolver.invalidateContact({
      phone_normalized: '+16025550100',
      email: 'never-cached@acme.com',
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('phone:');
  });

  it('leaves other contacts alone', async () => {
    await resolver.resolve('+16025550100');
    await resolver.resolve('other@acme.com');
    const warmCalls = global.fetch.mock.calls.length;

    resolver.invalidateContact({ phone_normalized: '+16025550100' });

    await resolver.resolve('other@acme.com');
    expect(global.fetch.mock.calls.length).toBe(warmCalls);
  });

  it('tolerates a malformed or empty payload rather than throwing', async () => {
    for (const payload of [null, undefined, {}, 'nonsense', 42, []]) {
      expect(() => resolver.invalidateContact(payload)).not.toThrow();
      expect(resolver.invalidateContact(payload)).toEqual([]);
    }
  });

  it('ignores non-string identifier fields', async () => {
    expect(resolver.invalidateContact({ phone_normalized: 12345, email: { a: 1 } })).toEqual([]);
  });
});
