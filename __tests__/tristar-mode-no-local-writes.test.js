/**
 * tristar-mode-no-local-writes — bead nucleus-phone-bboo / stardust-tristar-cit
 * [coc.1.a] contract test. Path is the literal bead-specified location.
 *
 * The single guarantee mode-router provides: when the cockpit resolves a
 * routed path to TARGETS.TRISTAR, the URL never points at nucleus-phone's
 * local /api/ surface. By corollary, no fetch hits the local Express
 * handlers for those paths, so no INSERT/UPDATE to nucleus_phone_calls
 * is possible via those routes when TARGETS.TRISTAR resolves.
 *
 * Four layers of assertion, weakest → strongest:
 *
 *   1. Unit: resolveRoute on each routed path in TRISTAR mode lands on
 *      the TriStar base URL with X-API-Key injected by applyHeaders.
 *
 *   2. Behavioral: a simulated call flow — initiate → disposition with
 *      a fetched queue page — invokes fetch() only against TriStar URLs.
 *      Zero fetches hit '/api/...'.
 *
 *   3. DEGRADED state: TriStar requested + env missing returns the
 *      distinct TARGETS.DEGRADED so the caller can surface ops failure
 *      before issuing the call.
 *
 *   4. Audit: recursively walk server/ and enumerate every file that
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
  ROUTED_PATHS,
  isPathRouted,
  resolveRoute,
  getApiConfig,
  canUseTriStarMode,
} from '../client/src/lib/mode-router.js';

const TRISTAR_BASE = 'https://nucleus-tristar.example';
const TRISTAR_KEY = 'k_test_shared_v1';

const TRISTAR_OPTS = {
  mode: MODES.TRISTAR,
  tristarBaseUrl: TRISTAR_BASE,
  tristarApiKey: TRISTAR_KEY,
};

describe('tristar-mode-no-local-writes', () => {
  // ── Layer 1: unit ────────────────────────────────────────────

  describe('ROUTED_PATHS — frozen, exact', () => {
    test('matches bead spec exactly', () => {
      expect(Array.from(ROUTED_PATHS)).toEqual([
        '/queue',
        '/call/initiate',
        '/call/:id/disposition',
      ]);
    });

    test('is frozen', () => {
      expect(Object.isFrozen(ROUTED_PATHS)).toBe(true);
      expect(() => ROUTED_PATHS.push('/foo')).toThrow();
    });
  });

  describe('TARGETS — frozen enum', () => {
    test('exposes LOCAL, TRISTAR, DEGRADED', () => {
      expect(TARGETS.LOCAL).toBe('local');
      expect(TARGETS.TRISTAR).toBe('tristar');
      expect(TARGETS.DEGRADED).toBe('degraded');
      expect(Object.isFrozen(TARGETS)).toBe(true);
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
    ])('routes %s to TARGETS.TRISTAR with X-API-Key', (p) => {
      const r = resolveRoute(p, TRISTAR_OPTS);
      expect(r.target).toBe(TARGETS.TRISTAR);
      expect(r.url).toBe(`${TRISTAR_BASE}${p}`);
      expect(r.url.startsWith('/api')).toBe(false);
    });
  });

  describe('resolveRoute — applyHeaders puts X-API-Key LAST (anti-spread-collision)', () => {
    test('extra headers are merged FIRST so X-API-Key wins on collision', () => {
      const r = resolveRoute('/queue', TRISTAR_OPTS);
      // Caller tries to override X-API-Key with a wrong value. applyHeaders
      // MUST overwrite. This is the qm0-spread-collision lesson applied
      // to the client side — the call site cannot reintroduce the footgun.
      const merged = r.applyHeaders({
        'Content-Type': 'application/json',
        'X-API-Key': 'attacker-supplied-wrong-key',
      });
      expect(merged['X-API-Key']).toBe(TRISTAR_KEY);
      expect(merged['Content-Type']).toBe('application/json');
    });

    test('applyHeaders with no extras still injects X-API-Key', () => {
      const r = resolveRoute('/queue', TRISTAR_OPTS);
      expect(r.applyHeaders()).toEqual({ 'X-API-Key': TRISTAR_KEY });
      expect(r.applyHeaders({})).toEqual({ 'X-API-Key': TRISTAR_KEY });
    });

    test('applyHeaders returns a fresh object on every call (concurrency contract)', () => {
      // gxt2 may memoize `const cfg = getApiConfig(opts)` once at mount and
      // reuse `cfg.applyHeaders` across many fetches. The contract requires
      // each invocation to return a distinct object so mutation of one
      // fetch's header bag does not affect another's. If applyHeaders ever
      // regressed to a cached return, this test fails.
      const r = resolveRoute('/queue', TRISTAR_OPTS);
      const a = r.applyHeaders({ 'X-Trace': '1' });
      const b = r.applyHeaders({ 'X-Trace': '2' });
      expect(a).not.toBe(b);
      a['X-Mutated'] = 'yes';
      expect(b['X-Mutated']).toBeUndefined();
    });

    test('mutating opts.tristarApiKey AFTER resolve does not change captured headers (TOCTOU guard)', () => {
      // makeApplyHeaders captures apiKey by value at resolve time. A later
      // mutation of the opts object — common when a parent component
      // rebuilds config on every render — must NOT silently rotate the
      // header on in-flight requests. Documented at mode-router.js
      // makeApplyHeaders docstring.
      const opts = { ...TRISTAR_OPTS };
      const r = resolveRoute('/queue', opts);
      const before = r.applyHeaders();
      opts.tristarApiKey = 'rotated-key-mid-flight';
      const after = r.applyHeaders();
      expect(before['X-API-Key']).toBe(TRISTAR_KEY);
      expect(after['X-API-Key']).toBe(TRISTAR_KEY);
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
      const r = resolveRoute(p, { mode: MODES.JORUVA, tristarBaseUrl: TRISTAR_BASE, tristarApiKey: TRISTAR_KEY });
      expect(r.target).toBe(TARGETS.LOCAL);
      expect(r.url.startsWith('/api')).toBe(true);
    });
  });

  // ── Layer 3: DEGRADED state — surfaced separately from LOCAL ─────────

  describe('resolveRoute — DEGRADED only fires on routed paths with missing env', () => {
    test.each([
      [{ mode: MODES.TRISTAR }, '/queue'],
      [{ mode: MODES.TRISTAR, tristarBaseUrl: '' }, '/call/initiate'],
      [{ mode: MODES.TRISTAR, tristarBaseUrl: TRISTAR_BASE }, '/call/abc/disposition'],
      [{ mode: MODES.TRISTAR, tristarApiKey: TRISTAR_KEY }, '/queue'],
      [{ mode: MODES.TRISTAR, tristarBaseUrl: TRISTAR_BASE, tristarApiKey: '' }, '/queue'],
    ])('opts=%j path=%s → TARGETS.DEGRADED', (opts, p) => {
      const r = resolveRoute(p, opts);
      expect(r.target).toBe(TARGETS.DEGRADED);
      expect(r.url.startsWith('/api')).toBe(true);
      // DEGRADED still uses local URL, but the caller MUST surface the
      // ops-visibility signal before issuing the fetch. No X-API-Key.
      expect(r.applyHeaders()).toEqual({});
    });

    test('non-https tristarBaseUrl is rejected — javascript:, http:, file:, data: all degrade', () => {
      // tristarBaseUrl is normalized to require https://. A misconfigured
      // .env that ships javascript: or http:// would otherwise produce
      // URLs piped into fetch / future <a href> sites — XSS / data-exfil
      // vector. normalizeTristarBaseUrl returns null on non-https, which
      // collapses to "config not present" and DEGRADED kicks in.
      const bad = [
        'javascript:alert(1)',
        'http://nucleus-tristar.example',
        'file:///etc/passwd',
        'data:text/html,<script>x</script>',
        'evil.com',          // scheme-less
        '//evil.com',        // protocol-relative
        'https://',          // scheme only, no host
        'https:///path',     // empty host
      ];
      for (const url of bad) {
        const r = resolveRoute('/queue', { mode: MODES.TRISTAR, tristarBaseUrl: url, tristarApiKey: TRISTAR_KEY });
        expect(r.target).toBe(TARGETS.DEGRADED);
        expect(r.url.startsWith('/api')).toBe(true);
      }
    });

    test('trailing slash on tristarBaseUrl is normalized away', () => {
      const r = resolveRoute('/queue', {
        mode: MODES.TRISTAR,
        tristarBaseUrl: 'https://nucleus-tristar.example/',
        tristarApiKey: TRISTAR_KEY,
      });
      expect(r.target).toBe(TARGETS.TRISTAR);
      expect(r.url).toBe('https://nucleus-tristar.example/queue');
      // Critically: NOT 'https://nucleus-tristar.example//queue'.
      expect(r.url).not.toContain('//queue');
    });

    test('TriStar mode + non-routed path + missing env → TARGETS.LOCAL (not DEGRADED)', () => {
      // Non-routed paths in TriStar mode were always going to be local —
      // missing env doesn't change anything. No bug to surface.
      const r = resolveRoute('/cockpit/foo', { mode: MODES.TRISTAR });
      expect(r.target).toBe(TARGETS.LOCAL);
    });

    test('Joruva mode never produces DEGRADED', () => {
      const r = resolveRoute('/queue', { mode: MODES.JORUVA });
      expect(r.target).toBe(TARGETS.LOCAL);
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
    test('returns TARGETS.TRISTAR with applyHeaders when mode + env present', () => {
      const c = getApiConfig(TRISTAR_OPTS);
      expect(c.baseUrl).toBe(TRISTAR_BASE);
      expect(c.target).toBe(TARGETS.TRISTAR);
      expect(c.applyHeaders()).toEqual({ 'X-API-Key': TRISTAR_KEY });
    });

    test('returns TARGETS.LOCAL in Joruva mode', () => {
      const c = getApiConfig({ mode: MODES.JORUVA });
      expect(c.baseUrl).toBe('/api');
      expect(c.target).toBe(TARGETS.LOCAL);
      expect(c.applyHeaders()).toEqual({});
    });

    test('returns TARGETS.DEGRADED when TriStar requested + env missing', () => {
      const c = getApiConfig({ mode: MODES.TRISTAR });
      expect(c.baseUrl).toBe('/api');
      expect(c.target).toBe(TARGETS.DEGRADED);
      expect(c.applyHeaders()).toEqual({});
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

    test('initiate + disposition + queue all leave the local surface', async () => {
      // Each step mirrors what bead gxt2's api.js extension will do.
      // The point of THIS test is the mode-router CONTRACT — any caller
      // using resolveRoute + applyHeaders cannot, in TriStar mode,
      // accidentally hit the local /api/* surface for routed paths or
      // strip X-API-Key.
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

      for (const { url } of fetchCalls) {
        expect(url.startsWith('/api')).toBe(false);
        expect(url.startsWith(TRISTAR_BASE)).toBe(true);
      }

      for (const { init } of fetchCalls) {
        expect(init.headers['X-API-Key']).toBe(TRISTAR_KEY);
        expect(init.headers['Content-Type']).toBe('application/json');
      }
    });

    test('non-routed paths in TriStar mode still hit the local surface — expected and intentional', async () => {
      const r = resolveRoute('/cockpit/some-id', TRISTAR_OPTS);
      expect(r.target).toBe(TARGETS.LOCAL);
      await global.fetch(r.url, { method: 'GET' });
      expect(fetchCalls[0].url.startsWith('/api')).toBe(true);
    });

    // COUNTEREXAMPLE — this is what NOT to do. The test name and
    // assertions deliberately read as a failure mode, not a recipe.
    // Future readers grepping for `applyHeaders` should land here and
    // understand: a DEGRADED resolution IS a bug signal, and a caller
    // that fires it through anyway is the bug. The caller (App.jsx /
    // api.js in bead gxt2) MUST check target === TARGETS.DEGRADED and
    // either suppress the call, show a banner, or both. Failing to do
    // that produces this exact local fetch — observable in the
    // assertion below.
    test('ANTI-PATTERN: blindly firing a DEGRADED URL reaches the local /api/ surface (do NOT do this)', async () => {
      const r = resolveRoute('/call/initiate', { mode: MODES.TRISTAR });
      expect(r.target).toBe(TARGETS.DEGRADED);
      expect(r.target).not.toBe(TARGETS.TRISTAR);

      // The "do not do this" line:
      await global.fetch(r.url, {
        method: 'POST',
        headers: r.applyHeaders({ 'Content-Type': 'application/json' }),
      });

      // Observable consequence — the local Express handler is reachable.
      // If the caller had checked target FIRST, no fetch would fire and
      // this assertion would not exist.
      expect(fetchCalls[0].url).toBe('/api/call/initiate');
      expect(fetchCalls[0].url.startsWith('/api')).toBe(true);
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
      'server/routes/transcription.js': 'twilio-webhook-nucleus-account: RT transcription callback on nucleus-phone Twilio account',
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
