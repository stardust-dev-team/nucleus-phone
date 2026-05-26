/**
 * mode-router.js — bead nucleus-phone-bboo / stardust-tristar-cit [coc.1.a].
 *
 * Routes a small surface of API paths to nucleus-tristar's deployment when
 * the cockpit is in "TriStar mode," and to nucleus-phone's local /api/
 * surface otherwise. The three routed paths are exactly the ones that
 * would write to nucleus-phone's local nucleus_phone_calls table via the
 * cockpit's outbound flow:
 *
 *   - /queue                  — TriStar-only endpoint (no local equivalent)
 *   - /call/initiate          — local INSERT lives at server/routes/call.js:60
 *   - /call/:id/disposition   — local UPDATEs live at server/routes/history.js
 *                                (nucleus-phone exposes this at
 *                                 /api/history/:id/disposition; TriStar
 *                                 exposes it at /api/call/:id/disposition —
 *                                 mode-router routes the TriStar-flavored
 *                                 path. Cockpit code in bead e91e is what
 *                                 picks which flavor to call per mode.)
 *
 * The single contract this module guarantees: when the resolved target is
 * TARGETS.TRISTAR, the returned URL never points at the local /api/
 * surface. By corollary, in resolved-TriStar mode no fetch hits
 * nucleus-phone's Express handlers for those paths, so no INSERT/UPDATE
 * to nucleus_phone_calls is possible via those routes. The write-site
 * audit lives in __tests__/tristar-mode-no-local-writes.test.js.
 *
 * --- v1 trust model + v2 follow-up ---
 *
 * nucleus-tristar/src/middleware/api-key.js:7 documents that
 * TRISTAR_API_KEY is "a single shared" deployment secret. For v1, the
 * cockpit holds it client-side via Vite build-time env (caller supplies
 * tristarApiKey to resolveRoute / getApiConfig). That key is therefore
 * extractable from the browser bundle by anyone with dev tools — an
 * intentional trade-off for the Britt/Blake/Tom v1 rollout.
 *
 * v2 follow-up (bead nucleus-phone-stet, P1): proxy through nucleus-phone's
 * server (route prefix like /api/tristar/*) and keep the key in
 * nucleus-phone's env. A second sibling bead nucleus-phone-kvje (P2)
 * adds a server-side X-Cockpit-Mode guard as defense-in-depth. Until
 * stet lands, do NOT enable TriStar mode for external_caller principals
 * you don't trust with the shared key.
 *
 * --- misconfig posture (TARGETS.DEGRADED) ---
 *
 * If mode === TRISTAR but tristarBaseUrl/tristarApiKey are missing or
 * empty, resolveRoute returns TARGETS.DEGRADED — a third resolved-target
 * value distinct from both LOCAL (intentional Joruva mode) and TRISTAR.
 * The URL still resolves to the local /api/ surface (cockpit stays
 * functional), but the target carries the "this was supposed to be
 * TriStar" signal to the caller. The caller MUST surface this in ops
 * (banner, console.warn, Slack alert) — see canonicalize-degrade.test.
 *
 * Why DEGRADED is a distinct state instead of a flag on LOCAL: a request
 * that LOOKS like local but came from "user wanted TriStar" is a bug
 * signal, not a normal Joruva-mode dial. Conflating them hides the bug.
 * The no-local-writes contract is scoped to TARGETS.TRISTAR specifically:
 * a degraded request DOES touch nucleus_phone_calls (it's a local
 * write), but the caller is responsible for either suppressing the call
 * or warning the user before issuing it.
 *
 * --- header-merge contract ---
 *
 * resolveRoute / getApiConfig return an `applyHeaders(extra)` function
 * rather than a plain `headers` object. The function controls merge
 * order: caller-supplied headers go in first, mode-router auth headers
 * (X-API-Key) go in last and always win. This makes the spread-collision
 * footgun (nucleus-tristar/src/routes/queue.js:204-209, the qm0 lesson)
 * impossible to reintroduce at the call site:
 *
 *   // CORRECT — function controls order:
 *   fetch(r.url, { headers: r.applyHeaders({ 'Content-Type': 'application/json' }) })
 *
 *   // No way to write the wrong thing — there's no `r.headers` to spread
 *   // and `applyHeaders` always puts auth last.
 *
 * --- pure, injectable ---
 *
 * No process.env / import.meta.env reads here. All config is injected by
 * the caller. This keeps tests trivially deterministic and lets the
 * server (jest server config) exercise the same code as the browser
 * without a Vite shim.
 */

export const MODES = Object.freeze({
  JORUVA: 'joruva',
  TRISTAR: 'tristar',
});

/**
 * Resolved-target enum. Distinct from MODES because a request that was
 * REQUESTED in TRISTAR mode can RESOLVE to TARGETS.DEGRADED (config
 * missing) — that's an observable, distinct outcome the caller must
 * branch on, not a flavor of LOCAL.
 */
export const TARGETS = Object.freeze({
  LOCAL: 'local',
  TRISTAR: 'tristar',
  DEGRADED: 'degraded',
});

/**
 * The three paths that, in TriStar mode, leave the local /api/ surface.
 * Frozen so a mutation throws in strict mode (ES modules are implicit
 * strict mode, so push() throws in normal use). Mutating this set would
 * silently widen / narrow the routed surface and relax the no-local-writes
 * contract — the freeze converts that footgun into a runtime error.
 *
 * Order matches the bead spec; downstream code must not depend on order.
 */
export const ROUTED_PATHS = Object.freeze([
  '/queue',
  '/call/initiate',
  '/call/:id/disposition',
]);

/**
 * Escape regex metacharacters in a literal string. Standard recipe.
 * Used so a future ROUTED_PATHS entry containing '.', '+', '?', etc.
 * does not silently become a regex wildcard.
 */
function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a path template (with :param segments) to an anchored regex.
 *
 *   - Split the template on :name boundaries (param-name = [A-Za-z_]\w*).
 *   - Escape each literal segment.
 *   - Replace each :name with [^/]+ (single segment, no slashes).
 *   - Anchor both ends so '/queue' does not match '/queue/extra' and
 *     '/call/initiate.json' does not match '/call/initiate'.
 *
 * Hyphens-in-param-names (':user-id') are NOT supported by the param
 * regex; if a future ROUTED_PATHS entry needs that, extend the param
 * regex deliberately rather than papering over it at the call site.
 */
function compilePathTemplate(template) {
  const PARAM = /:[A-Za-z_]\w*/g;
  let pattern = '';
  let lastIndex = 0;
  let m;
  while ((m = PARAM.exec(template)) !== null) {
    pattern += escapeRegexLiteral(template.slice(lastIndex, m.index));
    pattern += '[^/]+';
    lastIndex = PARAM.lastIndex;
  }
  pattern += escapeRegexLiteral(template.slice(lastIndex));
  return new RegExp(`^${pattern}$`);
}

// Derived from ROUTED_PATHS at module load. Safe to keep separate
// because ROUTED_PATHS is frozen — no mutation can drift the two arrays
// apart at runtime. Tests pin this property.
const ROUTED_PATH_REGEXES = ROUTED_PATHS.map(compilePathTemplate);

/**
 * True iff the path matches one of the routed-path templates.
 *
 * @param {string} path — request path WITHOUT the /api prefix (e.g.,
 *   '/queue', '/call/initiate', '/call/abc-123/disposition'). Caller is
 *   responsible for stripping any leading /api/.
 */
export function isPathRouted(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return ROUTED_PATH_REGEXES.some((re) => re.test(path));
}

/**
 * True iff the user is permitted to flip into TriStar mode. The bead
 * spec gates v1 to Britt/Blake/Tom; the caller supplies the allowlist
 * (typically from a server-driven config so the gate can be changed
 * without a redeploy). This module does not hardcode identities.
 *
 * Returns false defensively on missing user, empty identity, empty
 * allowlist, or shape mismatch — TriStar mode stays opt-in.
 */
export function canUseTriStarMode(user, allowedIdentities) {
  if (!user || typeof user.identity !== 'string' || user.identity.length === 0) return false;
  if (!Array.isArray(allowedIdentities) || allowedIdentities.length === 0) return false;
  return allowedIdentities.includes(user.identity);
}

/**
 * tristarBaseUrl must be a fully-qualified https:// URL. We REJECT any
 * other shape — javascript:, file:, data:, scheme-less hosts, or even
 * http:// — because the resolved URL may be passed to fetch (fine) OR
 * to `<a href>` / `window.location` / similar by future call sites. A
 * permissive base URL is an XSS / data-exfil vector waiting for a
 * cockpit refactor to find it.
 *
 * Trailing slash is stripped so concatenation with the path (which
 * always leads with /) doesn't produce double slashes.
 */
function normalizeTristarBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Require at least one host character after the scheme so 'https://' alone
  // doesn't survive normalization and produce a hostless URL on concat.
  if (!/^https:\/\/[^/]/.test(raw)) return null;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Resolve TriStar config from opts. Returns null if mode is not TRISTAR
 * or env is missing/invalid. Shared by resolveRoute + getApiConfig.
 *
 * Tolerates null/undefined opts (returns null) so resolveRoute(path) and
 * resolveRoute(path, null) behave symmetrically — null is a normal way
 * to say "no config" in JS and shouldn't TypeError on destructure.
 */
function resolveTristarConfig(opts) {
  if (!opts || typeof opts !== 'object') return null;
  const { mode, tristarBaseUrl, tristarApiKey } = opts;
  if (mode !== MODES.TRISTAR) return null;
  const baseUrl = normalizeTristarBaseUrl(tristarBaseUrl);
  if (!baseUrl) return null;
  if (typeof tristarApiKey !== 'string' || tristarApiKey.length === 0) return null;
  return { baseUrl, apiKey: tristarApiKey };
}

/**
 * Build the applyHeaders function for a given resolved config. Caller
 * passes `extra` (its own headers like Content-Type, Accept) and the
 * function returns a merged object with mode-router auth headers spread
 * LAST so they always win. Footgun-proof by construction.
 *
 * Concurrency contract:
 *   - Returns a FRESH object on every invocation. Safe to call concurrently
 *     across many in-flight fetches; mutating the returned object affects
 *     only that caller, never future calls or other in-flight ones.
 *   - Captures `tristarConfig.apiKey` by value at resolve time (via the
 *     enclosing closure). The headers reflect the config-as-of-resolveRoute,
 *     NOT config-as-of-applyHeaders-call. A future refactor that reads
 *     apiKey lazily would introduce a TOCTOU between resolve and fetch —
 *     don't do that without revisiting the rotate-without-restart story.
 */
function makeApplyHeaders(tristarConfig) {
  if (tristarConfig) {
    const apiKey = tristarConfig.apiKey;
    return (extra = {}) => ({ ...extra, 'X-API-Key': apiKey });
  }
  return (extra = {}) => ({ ...extra });
}

/**
 * Resolve a request path to a fully-qualified URL, target, and a header
 * merger, given the current mode and TriStar config.
 *
 * Returns:
 *   {
 *     url: string,
 *     target: 'local' | 'tristar' | 'degraded',
 *     applyHeaders: (extra) => mergedHeaders,
 *   }
 *
 * Behavior matrix:
 *   mode=JORUVA, any path (env present or absent): → LOCAL (tristar config ignored)
 *   mode=TRISTAR, path routed, env present:        → TRISTAR
 *   mode=TRISTAR, path NOT routed:                 → LOCAL
 *   mode=TRISTAR, path routed, env missing/invalid:→ DEGRADED (still local URL)
 *   mode=TRISTAR, path NOT routed, env missing:    → LOCAL
 *
 * DEGRADED only fires when the caller asked for TriStar AND the path
 * IS in ROUTED_PATHS AND env is missing — i.e., precisely the case
 * where the cockpit thinks it's doing TriStar work but actually isn't.
 * That's the bug signal worth surfacing.
 */
export function resolveRoute(path, opts) {
  const tristarConfig = resolveTristarConfig(opts);
  const wantsTristar = opts && typeof opts === 'object' && opts.mode === MODES.TRISTAR;

  if (tristarConfig && isPathRouted(path)) {
    return {
      url: `${tristarConfig.baseUrl}${path}`,
      target: TARGETS.TRISTAR,
      applyHeaders: makeApplyHeaders(tristarConfig),
    };
  }

  if (wantsTristar && !tristarConfig && isPathRouted(path)) {
    return {
      url: `/api${path}`,
      target: TARGETS.DEGRADED,
      applyHeaders: makeApplyHeaders(null),
    };
  }

  return {
    url: `/api${path}`,
    target: TARGETS.LOCAL,
    applyHeaders: makeApplyHeaders(null),
  };
}

/**
 * Convenience: caller-side recipe for the base URL + auth without a
 * specific path. Same shape as resolveRoute minus the url. Useful for
 * code paths that build URLs with query strings dynamically.
 *
 * Same DEGRADED semantics: requested TriStar with missing env returns
 * DEGRADED so the caller can surface ops visibility before issuing any
 * routed request.
 */
export function getApiConfig(opts) {
  const tristarConfig = resolveTristarConfig(opts);
  const wantsTristar = opts && typeof opts === 'object' && opts.mode === MODES.TRISTAR;

  if (tristarConfig) {
    return {
      baseUrl: tristarConfig.baseUrl,
      target: TARGETS.TRISTAR,
      applyHeaders: makeApplyHeaders(tristarConfig),
    };
  }

  if (wantsTristar && !tristarConfig) {
    return {
      baseUrl: '/api',
      target: TARGETS.DEGRADED,
      applyHeaders: makeApplyHeaders(null),
    };
  }

  return {
    baseUrl: '/api',
    target: TARGETS.LOCAL,
    applyHeaders: makeApplyHeaders(null),
  };
}
