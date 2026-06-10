/**
 * team-registry.conformance.test.js — Validates the canonical rep registry.
 *
 * This file exists because of the 2026-05-19 drift incident: the production
 * INBOUND_ROUTES env var had been silently re-pointed from Ryann to Tom on
 * +16026000188, while the code comment, unit tests, and runbook all still
 * said "Ryann". Nothing caught the drift. After the inbound-routes.json
 * canonicalization (commit 55b9e65), Linus's review (Linus #6) flagged that
 * the SAME drift shape lived in escalation.js (PHONE_TOM env var) and
 * sim.js (direct team-phones.json read). This file is the conformance gate
 * for the consolidated team-registry that closes all three holes.
 *
 * If a route's intended owner changes, update both team.json AND the drift
 * sentinel below in the same commit. The fs-based jest hoisting trick used
 * in incoming.test.js doesn't apply here — this test exercises the REAL
 * registry intentionally.
 */

const { loadRegistry, _resetForTesting } = require('../team-registry');

// Force the next loadRegistry() to read disk fresh — other test files in the
// run may have cached a mocked instance.
beforeAll(() => {
  _resetForTesting();
});

describe('team-registry schema', () => {
  let registry;

  beforeAll(() => {
    registry = loadRegistry();
  });

  test('loads without errors', () => {
    expect(registry).toBeTruthy();
    expect(Array.isArray(registry.reps)).toBe(true);
    expect(registry.reps.length).toBeGreaterThan(0);
  });

  test('every rep has identity, name, email, role', () => {
    for (const rep of registry.reps) {
      expect(typeof rep.identity).toBe('string');
      expect(rep.identity.length).toBeGreaterThan(0);
      expect(typeof rep.name).toBe('string');
      expect(typeof rep.email).toBe('string');
      expect(rep.email).toMatch(/@joruva\.com$/);
      expect(typeof rep.role).toBe('string');
    }
  });

  test('every inbound entry has a valid DID + type + complete route', () => {
    for (const rep of registry.reps) {
      if (rep.inbound === null) continue;
      expect(rep.inbound.did).toMatch(/^\+1\d{10}$/);
      expect(['forward', 'iosIdentity']).toContain(rep.inbound.type);

      // The merged route must be complete — either iosIdentity OR forward,
      // never neither. (If type=forward, the loader must have found a
      // mobile in team-phones.json; if it didn't, loadRegistry() throws
      // at boot — so reaching here means the route is good.)
      const route = registry.getInboundRoute(rep.inbound.did);
      expect(route).not.toBeNull();
      expect(route.name).toBe(rep.name);
      if (rep.inbound.type === 'iosIdentity') {
        expect(typeof route.iosIdentity).toBe('string');
      } else {
        expect(route.forward).toMatch(/^\+1\d{10}$/);
      }
    }
  });

  test('all identities are unique', () => {
    const seen = new Set();
    for (const rep of registry.reps) {
      expect(seen.has(rep.identity)).toBe(false);
      seen.add(rep.identity);
    }
  });

  test('all inbound DIDs are unique', () => {
    const seen = new Set();
    for (const rep of registry.reps) {
      if (!rep.inbound) continue;
      expect(seen.has(rep.inbound.did)).toBe(false);
      seen.add(rep.inbound.did);
    }
  });
});

describe('team-registry drift sentinels (Linus #6 — consolidated registry)', () => {
  let registry;

  beforeAll(() => {
    registry = loadRegistry();
  });

  // 2026-06-08 CORRECTION sentinel #1: +16026000188 is TOM's, routes to
  // his iOS CallKit. The prior 2026-05-19 sentinel asserted this DID was
  // Ryann's — citing "5 sources said Ryann; the env var saying Tom was the
  // drift." Tom confirmed 2026-06-08 that was backwards: +16026000188 is
  // HIS number (the env var saying Tom was correct all along), wrongly
  // assigned to Ryann here. Tom + Ryann's DIDs are now swapped: Tom owns
  // +16026000188 (iOS CallKit), Ryann owns +16234620197 (PSTN forward).
  // Slack assertion dropped (Linus #4) — Slack ID is metadata, not
  // routing-load-bearing.
  test('+16026000188 routes to Tom via iOS CallKit', () => {
    const route = registry.getInboundRoute('+16026000188');
    expect(route).not.toBeNull();
    expect(route.name).toBe('Tom');
    expect(route.iosIdentity).toBe('tom');
    expect(route.forward).toBeUndefined();
  });

  // 2026-06-08 CORRECTION sentinel #2: +16234620197 is Ryann's, routes to
  // her cell via PSTN forward. Reassigned from Tom 2026-06-08 (was Tom's
  // iOS CallKit DID; swapped with +16026000188 — see sentinel #1).
  test('+16234620197 routes to Ryann via PSTN forward', () => {
    const route = registry.getInboundRoute('+16234620197');
    expect(route).not.toBeNull();
    expect(route.name).toBe('Ryann');
    expect(route.forward).toMatch(/^\+1\d{10}$/);
    expect(route.iosIdentity).toBeUndefined();
  });

  // Britt is outbound-only — she has a VoIP token registered in
  // nucleus_phone_voip_tokens but no inbound DID provisioned (2026-05-19
  // deferral). If she gets a DID later, this sentinel needs to update.
  test('Britt has no inbound entry (outbound-only, deferral 2026-05-19)', () => {
    const britt = registry.getRepByIdentity('britt');
    expect(britt).not.toBeNull();
    expect(britt.inbound).toBeNull();
  });

  // 2026-06-09: getRepByIdentity must be case-insensitive. Paul's client
  // began sending caller_identity "Paul" (display-cased) instead of "paul";
  // because Paul is admin, enforceOwnIdentity didn't reject the mismatch, so
  // outboundCallerId('Paul') missed the lowercase-keyed registry and fell back
  // to NUCLEUS_PHONE_NUMBER (+16026000188) — every Paul call presented Tom's
  // DID. Pin the case-insensitive contract so a future exact-match regression
  // reproduces the outage.
  test('getRepByIdentity is case-insensitive (display-cased "Paul" → paul)', () => {
    const lower = registry.getRepByIdentity('paul');
    const upper = registry.getRepByIdentity('Paul');
    expect(upper).not.toBeNull();
    expect(upper.identity).toBe('paul');
    expect(upper).toBe(lower);
    // The whole point: the resolved rep must yield Paul's own DID, not a fallback.
    expect(upper.inbound.did).toBe('+16029050230');
  });
});
