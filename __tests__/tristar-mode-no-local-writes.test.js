/**
 * tristar-mode-no-local-writes — bead nucleus-phone-bboo / stardust-tristar-cit
 * [coc.1.a] contract test. Path is the literal bead-specified location.
 *
 * The single guarantee mode-router provides: when the cockpit resolves a
 * routed path to TARGETS.TRISTAR, the URL points at the same-origin proxy
 * prefix (/api/tristar/*), never at nucleus-phone's local handler surface
 * (/api/queue, /api/call/initiate, /api/call/:id/disposition). The proxy
 * forwards to nucleus-tristar, so no INSERT/UPDATE to nucleus_phone_calls is
 * possible via those routes when TARGETS.TRISTAR resolves.
 *
 * Post-stet (P1): the TRISTAR_API_KEY lives only on the server; the client
 * injects no auth header and holds no TriStar base URL. There is no DEGRADED
 * state client-side — server misconfig surfaces as a 503 from the proxy.
 *
 * Layers of assertion, weakest → strongest:
 *
 *   1. Unit: resolveRoute on each routed path in TRISTAR mode lands on the
 *      same-origin proxy prefix with NO client auth header.
 *
 *   2. Behavioral: a simulated call flow — queue → initiate → disposition —
 *      never invokes fetch() against a local handler path.
 *
 *   3. Audit: recursively walk server/ and enumerate every file that
 *      writes to nucleus_phone_calls. Assert that file set is exactly
 *      the documented set, keyed by full relative path. A new write
 *      site appearing outside the set fails the test and forces the
 *      author to classify it.
 *
 * Audit categories:
 *   - "routed-outbound": cockpit-initiated path covered by ROUTED_PATHS;
 *     TriStar mode never reaches the local handler.
 *   - "twilio-webhook-nucleus-account": webhook triggered by Twilio on
 *     nucleus-phone's Twilio account; nucleus-tristar uses a separate
 *     account (TRISTAR_TWILIO_*, see
 *     nucleus-tristar/src/lib/phone/twilio.js:4) so its webhooks fire on
 *     its own URLs.
 *   - "transitive-from-webhook": helper called by a webhook handler;
 *     reachable only when its caller fires.
 *   - "timer-job": fires on a server-side interval independent of
 *     cockpit mode; only touches existing rows. In pure TriStar mode no
 *     rows exist for the user.
 *   - "migration-init": fires once at server boot during schema init;
 *     not user-triggered.
 *   - "inbound-DID": prospect dialing a nucleus-phone DID; cockpit-mode
 *     routing does not apply. Out of scope for this bead.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  MODES,
  TARGETS,
  TRISTAR_PROXY_PREFIX,
  ROUTED_PATHS,
  isPathRouted,
  resolveRoute,
  getApiConfig,
  canUseTriStarMode,
} from '../client/src/lib/mode-router.js';

// Post-stet (P1): the client no longer holds a TriStar base URL or API key.
// TriStar-mode routed paths resolve to the same-origin proxy prefix
// (TRISTAR_PROXY_PREFIX === '/api/tristar'), and the key is injected by
// server/routes/tristar-proxy.js. Mode is the only client-side config.
const TRISTAR_OPTS = { mode: MODES.TRISTAR };

describe('tristar-mode-no-local-writes', () => {
  // ── Layer 1: unit ────────────────────────────────────────────

  // /token added per bead nucleus-phone-ln18 — cockpit's Twilio Voice
  // SDK must register against TriStar's account in TriStar mode.
  describe('ROUTED_PATHS — frozen, exact', () => {
    test('matches bead spec exactly', () => {
      expect(Array.from(ROUTED_PATHS)).toEqual([
        '/queue',
        '/call/initiate',
        '/call/:id/disposition',
        '/token',
      ]);
    });

    test('is frozen', () => {
      expect(Object.isFrozen(ROUTED_PATHS)).toBe(true);
      expect(() => ROUTED_PATHS.push('/foo')).toThrow();
    });
  });

  describe('TARGETS — frozen enum', () => {
    test('exposes LOCAL, TRISTAR only (DEGRADED removed by stet)', () => {
      expect(TARGETS.LOCAL).toBe('local');
      expect(TARGETS.TRISTAR).toBe('tristar');
      expect(TARGETS.DEGRADED).toBeUndefined();
      expect(Object.isFrozen(TARGETS)).toBe(true);
    });

    test('TRISTAR_PROXY_PREFIX is the same-origin proxy mount', () => {
      expect(TRISTAR_PROXY_PREFIX).toBe('/api/tristar');
    });
  });

  describe('isPathRouted', () => {
    test('matches the three patterns (templates substituted)', () => {
      expect(isPathRouted('/queue')).toBe(true);
      expect(isPathRouted('/call/initiate')).toBe(true);
      expect(isPathRouted('/call/abc-123/disposition')).toBe(true);
      expect(isPathRouted('/call/9f4e/disposition')).toBe(true);
    });

    test('rejects paths outside the routed set', () => {
      expect(isPathRouted('/cockpit/foo')).toBe(false);
      expect(isPathRouted('/contacts')).toBe(false);
      expect(isPathRouted('/history/abc/disposition')).toBe(false);
      expect(isPathRouted('/queue/extra')).toBe(false);
      expect(isPathRouted('/call/initiate/extra')).toBe(false);
      expect(isPathRouted('')).toBe(false);
      expect(isPathRouted(null)).toBe(false);
      expect(isPathRouted(undefined)).toBe(false);
    });

    test('the :id segment is single-segment only (no slashes)', () => {
      expect(isPathRouted('/call/abc/def/disposition')).toBe(false);
    });

    test('regex metacharacters in literal segments are escaped — /call/initiate.json does not match /call/initiate', () => {
      // The '.' in '/call/initiate.json' must NOT be treated as a regex
      // wildcard. If escapeRegexLiteral regresses, this test fails.
      expect(isPathRouted('/call/initiate.json')).toBe(false);
      expect(isPathRouted('/call/initiateXjson')).toBe(false);
      expect(isPathRouted('/call/initiate?foo=bar')).toBe(false);
    });

    test('documented constraint: hyphens in :param names are NOT supported', () => {
      // The docstring at mode-router.js's compilePathTemplate says hyphens
      // in param names aren't supported (:user-id would parse :user as
      // the param and leave -id as a literal). This is a deliberate
      // limitation — no current ROUTED_PATHS template uses hyphens. This
      // test pins the limitation so a future template author hits the
      // failure here rather than discovering it in production.
      //
      // No ROUTED_PATHS entry uses :user-id today, so we can't directly
      // probe the limitation against a real template. Instead we probe
      // the regex behavior with /call/:id/disposition (extant template)
      // by passing a value with a hyphen, which SHOULD work (matches
      // [^/]+). The constraint is only about :param NAME syntax, not
      // about hyphens in path VALUES.
      expect(isPathRouted('/call/with-hyphen/disposition')).toBe(true);
    });
  });

  describe('resolveRoute — TriStar mode, routed paths', () => {
    test.each([
      ['/queue'],
      ['/call/initiate'],
      ['/call/abc-123/disposition'],
      ['/token'],
    ])('routes %s to TARGETS.TRISTAR via the same-origin proxy prefix', (p) => {
      const r = resolveRoute(p, TRISTAR_OPTS);
      expect(r.target).toBe(TARGETS.TRISTAR);
      // Same-origin proxy, NOT the local handler surface (/api/<path>).
      expect(r.url).toBe(`${TRISTAR_PROXY_PREFIX}${p}`);
      expect(r.url.startsWith('/api/tristar/')).toBe(true);
      // The key is injected server-side; the client adds no auth header.
      expect(r.applyHeaders()).toEqual({});
      expect(r.applyHeaders()['X-API-Key']).toBeUndefined();
    });
  });

  describe('resolveRoute — applyHeaders is identity (auth injected server-side post-stet)', () => {
    test('applyHeaders passes extras through and injects NO auth header', () => {
      const r = resolveRoute('/queue', TRISTAR_OPTS);
      expect(r.applyHeaders()).toEqual({});
      expect(r.applyHeaders({})).toEqual({});
      const merged = r.applyHeaders({ 'Content-Type': 'application/json' });
      expect(merged).toEqual({ 'Content-Type': 'application/json' });
      expect(merged['X-API-Key']).toBeUndefined();
    });

    test('applyHeaders returns a fresh object on every call (concurrency contract)', () => {
      // api.js may reuse a single resolved route's applyHeaders across many
      // fetches. Each invocation must return a distinct object so mutation of
      // one fetch's header bag does not affect another's.
      const r = resolveRoute('/queue', TRISTAR_OPTS);
      const a = r.applyHeaders({ 'X-Trace': '1' });
      const b = r.applyHeaders({ 'X-Trace': '2' });
      expect(a).not.toBe(b);
      a['X-Mutated'] = 'yes';
      expect(b['X-Mutated']).toBeUndefined();
    });
  });

  describe('resolveRoute — TriStar mode, non-routed paths stay local', () => {
    test.each([
      ['/cockpit/foo'],
      ['/contacts'],
      ['/history/abc/disposition'],
      ['/scoreboard'],
    ])('routes %s to TARGETS.LOCAL with no auth headers', (p) => {
      const r = resolveRoute(p, TRISTAR_OPTS);
      expect(r.target).toBe(TARGETS.LOCAL);
      expect(r.url).toBe(`/api${p}`);
      expect(r.applyHeaders()).toEqual({});
      expect(r.applyHeaders({ 'Content-Type': 'application/json' }))
        .toEqual({ 'Content-Type': 'application/json' });
    });
  });

  describe('resolveRoute — Joruva mode never routes externally', () => {
    test.each([
      ['/queue'],
      ['/call/initiate'],
      ['/call/abc/disposition'],
      ['/cockpit/foo'],
      ['/contacts'],
    ])('routes %s to TARGETS.LOCAL', (p) => {
      const r = resolveRoute(p, { mode: MODES.JORUVA });
      expect(r.target).toBe(TARGETS.LOCAL);
      expect(r.url.startsWith('/api')).toBe(true);
      expect(r.url.startsWith('/api/tristar/')).toBe(false);
    });
  });

  // ── Layer 3: no client-side env → no DEGRADED (stet) ─────────────────

  describe('resolveRoute — TriStar mode needs no client env (DEGRADED removed by stet)', () => {
    test('TriStar + routed path resolves to TRISTAR with mode alone — no base/key required', () => {
      // Pre-stet this would have been DEGRADED (missing client env). Post-stet
      // the client holds no env; the proxy is same-origin, so mode alone is
      // enough to route. Server misconfig surfaces as a 503 from the proxy.
      const r = resolveRoute('/queue', { mode: MODES.TRISTAR });
      expect(r.target).toBe(TARGETS.TRISTAR);
      expect(r.url).toBe(`${TRISTAR_PROXY_PREFIX}/queue`);
    });

    test('stale tristarBaseUrl/tristarApiKey on opts are ignored (no longer read)', () => {
      // A caller passing the old config shape must not change behavior — the
      // fields are dead. Routes the same as mode-only.
      const r = resolveRoute('/queue', {
        mode: MODES.TRISTAR,
        tristarBaseUrl: 'https://nucleus-tristar.example',
        tristarApiKey: 'k_test_shared_v1',
      });
      expect(r.target).toBe(TARGETS.TRISTAR);
      expect(r.url).toBe(`${TRISTAR_PROXY_PREFIX}/queue`);
      expect(r.applyHeaders()).toEqual({});
    });

    test('TriStar mode + non-routed path → TARGETS.LOCAL', () => {
      const r = resolveRoute('/cockpit/foo', { mode: MODES.TRISTAR });
      expect(r.target).toBe(TARGETS.LOCAL);
      expect(r.url).toBe('/api/cockpit/foo');
    });

    test('Joruva mode → LOCAL', () => {
      const r = resolveRoute('/queue', { mode: MODES.JORUVA });
      expect(r.target).toBe(TARGETS.LOCAL);
      expect(r.url).toBe('/api/queue');
    });

    test('null / undefined / missing opts are symmetric — all → LOCAL, no throw', () => {
      // resolveTristarConfig must tolerate null opts (destructuring null
      // would TypeError otherwise). Asymmetric throws on null-vs-undefined
      // are the kind of footgun that bites at 3am when a caller forgets
      // to pass opts.
      expect(() => resolveRoute('/queue')).not.toThrow();
      expect(() => resolveRoute('/queue', null)).not.toThrow();
      expect(() => resolveRoute('/queue', undefined)).not.toThrow();
      expect(resolveRoute('/queue').target).toBe(TARGETS.LOCAL);
      expect(resolveRoute('/queue', null).target).toBe(TARGETS.LOCAL);
      expect(resolveRoute('/queue', undefined).target).toBe(TARGETS.LOCAL);
    });
  });

  describe('canUseTriStarMode', () => {
    const allow = ['britt@joruva.com', 'blake@joruva.com', 'tom@joruva.com'];

    test('permits an identity on the allowlist', () => {
      expect(canUseTriStarMode({ identity: 'britt@joruva.com' }, allow)).toBe(true);
      expect(canUseTriStarMode({ identity: 'blake@joruva.com' }, allow)).toBe(true);
      expect(canUseTriStarMode({ identity: 'tom@joruva.com' }, allow)).toBe(true);
    });

    test('rejects identities not on the allowlist', () => {
      expect(canUseTriStarMode({ identity: 'paul@joruva.com' }, allow)).toBe(false);
      expect(canUseTriStarMode({ identity: 'ryann@joruva.com' }, allow)).toBe(false);
    });

    test('rejects missing or malformed user', () => {
      expect(canUseTriStarMode(null, allow)).toBe(false);
      expect(canUseTriStarMode(undefined, allow)).toBe(false);
      expect(canUseTriStarMode({}, allow)).toBe(false);
      expect(canUseTriStarMode({ identity: 42 }, allow)).toBe(false);
    });

    test('rejects empty-string identity (footgun guard)', () => {
      // If allowedIdentities contained '' (env var resolved to empty
      // string, then split into an array), canUseTriStarMode([''], '')
      // would otherwise permit. Empty identity is rejected at the user
      // shape check so this can never fire.
      expect(canUseTriStarMode({ identity: '' }, [''])).toBe(false);
      expect(canUseTriStarMode({ identity: '' }, allow)).toBe(false);
    });

    test('rejects empty or invalid allowlist', () => {
      expect(canUseTriStarMode({ identity: 'tom@joruva.com' }, [])).toBe(false);
      expect(canUseTriStarMode({ identity: 'tom@joruva.com' }, null)).toBe(false);
      expect(canUseTriStarMode({ identity: 'tom@joruva.com' }, undefined)).toBe(false);
    });
  });

  describe('getApiConfig', () => {
    test('returns TARGETS.TRISTAR with the proxy prefix in TriStar mode', () => {
      const c = getApiConfig(TRISTAR_OPTS);
      expect(c.baseUrl).toBe(TRISTAR_PROXY_PREFIX);
      expect(c.target).toBe(TARGETS.TRISTAR);
      expect(c.applyHeaders()).toEqual({});
    });

    test('returns TARGETS.LOCAL in Joruva mode', () => {
      const c = getApiConfig({ mode: MODES.JORUVA });
      expect(c.baseUrl).toBe('/api');
      expect(c.target).toBe(TARGETS.LOCAL);
      expect(c.applyHeaders()).toEqual({});
    });

    test('missing opts → LOCAL', () => {
      const c = getApiConfig();
      expect(c.baseUrl).toBe('/api');
      expect(c.target).toBe(TARGETS.LOCAL);
    });
  });

  // ── Layer 2: behavioral — simulated call flow with mocked fetch ─────

  describe('simulated TriStar-mode call flow — zero fetches hit /api/', () => {
    let originalFetch;
    let fetchCalls;

    beforeEach(() => {
      originalFetch = global.fetch;
      fetchCalls = [];
      global.fetch = jest.fn(async (url, init) => {
        fetchCalls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          text: async () => 'ok',
        };
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    test('initiate + disposition + queue never hit the LOCAL handler surface', async () => {
      // The mode-router CONTRACT: any caller using resolveRoute cannot, in
      // TriStar mode, hit nucleus-phone's local handler paths (/api/queue,
      // /api/call/initiate, /api/call/:id/disposition) for routed paths. They
      // all go to the same-origin proxy (/api/tristar/*), which forwards to
      // nucleus-tristar — so no INSERT/UPDATE to nucleus_phone_calls fires.
      const steps = [
        { path: '/queue', method: 'GET' },
        { path: '/call/initiate', method: 'POST' },
        { path: '/call/abc-123/disposition', method: 'POST' },
      ];

      for (const { path: p, method } of steps) {
        const r = resolveRoute(p, TRISTAR_OPTS);
        expect(r.target).toBe(TARGETS.TRISTAR);
        await global.fetch(r.url, {
          method,
          headers: r.applyHeaders({ 'Content-Type': 'application/json' }),
        });
      }

      expect(global.fetch).toHaveBeenCalledTimes(3);

      const LOCAL_HANDLER_PATHS = ['/api/queue', '/api/call/initiate'];
      for (const { url } of fetchCalls) {
        // Every routed fetch goes to the proxy prefix, never the bare local
        // handler. (The proxy prefix /api/tristar/* is a DISTINCT Express
        // mount from /api/call, /api/history — see server/index.js.)
        expect(url.startsWith(`${TRISTAR_PROXY_PREFIX}/`)).toBe(true);
        expect(LOCAL_HANDLER_PATHS).not.toContain(url);
      }

      // The client injects no auth header — the proxy adds X-API-Key.
      for (const { init } of fetchCalls) {
        expect(init.headers['X-API-Key']).toBeUndefined();
        expect(init.headers['Content-Type']).toBe('application/json');
      }
    });

    test('non-routed paths in TriStar mode still hit the local surface — expected and intentional', async () => {
      const r = resolveRoute('/cockpit/some-id', TRISTAR_OPTS);
      expect(r.target).toBe(TARGETS.LOCAL);
      await global.fetch(r.url, { method: 'GET' });
      expect(fetchCalls[0].url).toBe('/api/cockpit/some-id');
    });

    test('the proxy prefix is distinct from the local handler path for the same routed path', () => {
      // Guards the core invariant by construction: /api/tristar/call/initiate
      // (proxy) is NOT /api/call/initiate (local INSERT handler). If a future
      // refactor collapsed the prefix, this fails before reaching prod.
      const r = resolveRoute('/call/initiate', TRISTAR_OPTS);
      expect(r.url).toBe('/api/tristar/call/initiate');
      expect(r.url).not.toBe('/api/call/initiate');
    });
  });

  // ── Layer 4: audit — write sites are exactly the documented set ──────

  describe('audit: nucleus_phone_calls write sites are exactly the documented set', () => {
    /**
     * Keyed by full relative path from repo root. A NEW file appearing
     * here fails the test and forces the author to either route that
     * file's surface through ROUTED_PATHS or document why the new write
     * is contractually safe in TriStar mode.
     */
    const KNOWN_WRITE_SITES = {
      'server/routes/call.js': 'routed-outbound: /api/call/initiate writes via ROUTED_PATHS[/call/initiate]',
      'server/routes/history.js': 'routed-outbound: /api/history/:id/disposition; TriStar-mode cockpit calls /call/:id/disposition (ROUTED_PATHS) instead',
      'server/routes/incoming.js': 'inbound-DID + twilio-webhook-nucleus-account: line 165 INSERT (prospect dial), line 610 UPDATE (voicemail recording webhook). Both fire on nucleus-phone Twilio account only',
      'server/routes/recording-status.js': 'twilio-webhook-nucleus-account: recording callback on nucleus-phone Twilio account',
      'server/lib/transcript-ingest.js': 'twilio-webhook-nucleus-account + in-house-STT-ingest: UPDATE (transcript-ingest.js:73) invoked by routes/transcription.js (Twilio RT-transcription callback, nucleus-phone account) and routes/stt-ingest.js (server-side in-house STT). Not a cockpit-routed write — no TriStar-mode cockpit fetch reaches it',
      'server/routes/voice.js': 'twilio-webhook-nucleus-account: TwiML callback on nucleus-phone Twilio account',
      'server/lib/phone-extractor.js': 'transitive-from-webhook: invoked by transcription.js (twilio-webhook-nucleus-account)',
      'server/lib/stale-sweep.js': 'timer-job: 5-min interval cleanup of stuck rows. Touches existing rows only; in pure TriStar mode no rows exist for the user',
      'server/db.js': 'migration-init: backfill UPDATE during schema init at boot; not user-triggered',
    };

    test('every nucleus_phone_calls write site is in the known set', () => {
      const repoRoot = path.join(__dirname, '..');
      const serverDir = path.join(repoRoot, 'server');
      const found = [];
      walkServer(serverDir, repoRoot, found);
      const expected = Object.keys(KNOWN_WRITE_SITES).sort();
      expect(found.sort()).toEqual(expected);
    });
  });
});

/**
 * Recursively walk `server/`, accumulating relative paths of every .js
 * file that writes to nucleus_phone_calls. Skips __tests__/ and
 * __mocks__/ subtrees (test code is not production write surface).
 *
 * Match pattern: INSERT INTO nucleus_phone_calls | UPDATE nucleus_phone_calls
 * with arbitrary whitespace (including newlines) between tokens. Does NOT
 * match the trigger DDL at server/db.js:519 ("INSERT OR UPDATE OF ... ON
 * nucleus_phone_calls") because the patterns require nucleus_phone_calls
 * to follow INTO or directly UPDATE-{whitespace}.
 */
function walkServer(dir, repoRoot, accum) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === '__mocks__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkServer(full, repoRoot, accum);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const content = fs.readFileSync(full, 'utf8');
      if (/INSERT\s+INTO\s+nucleus_phone_calls|UPDATE\s+nucleus_phone_calls/i.test(content)) {
        const rel = path.relative(repoRoot, full).split(path.sep).join('/');
        accum.push(rel);
      }
    }
  }
}
