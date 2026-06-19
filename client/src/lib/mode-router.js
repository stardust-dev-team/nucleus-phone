/**
 * mode-router.js — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.a];
 * reworked by nucleus-phone-stet (P1) for the server-side proxy.
 *
 * Routes a small surface of API paths to nucleus-tristar when the cockpit is
 * in "TriStar mode," and to nucleus-phone's local /api/ surface otherwise. The
 * routed paths are exactly the ones that would write to nucleus-phone's local
 * nucleus_phone_calls table via the cockpit's outbound flow:
 *
 *   - /queue                  — TriStar-only endpoint (no local equivalent)
 *   - /call/initiate          — local INSERT lives at server/routes/call.js
 *   - /call/:id/disposition   — local UPDATEs live at server/routes/history.js
 *                                (nucleus-phone exposes /api/history/:id/...;
 *                                 TriStar exposes /api/call/:id/disposition)
 *   - /token                  — Twilio Voice SDK JWT must come from TriStar's
 *                                Twilio account in TriStar mode
 *
 * --- v2 server-side proxy (bead stet) ---
 *
 * The shared TRISTAR_API_KEY no longer touches the browser. In TriStar mode a
 * routed path resolves to the SAME-ORIGIN proxy prefix /api/tristar/<path>
 * (server/routes/tristar-proxy.js), which injects the key server-side and
 * forwards to nucleus-tristar. This module therefore needs NO TriStar base URL
 * or API key — only the current mode. The browser cannot leak a key it never
 * receives.
 *
 * The single contract this module guarantees: when the resolved target is
 * TARGETS.TRISTAR, the returned URL points at /api/tristar/<path>, never at the
 * local /api/<path> surface. So in resolved-TriStar mode no fetch hits
 * nucleus-phone's Express handlers for those paths, and no INSERT/UPDATE to
 * nucleus_phone_calls is possible via them. The write-site audit lives in
 * __tests__/tristar-mode-no-local-writes.test.js.
 *
 * --- no DEGRADED state client-side ---
 *
 * Pre-stet, a third target (DEGRADED) signalled "TriStar requested but the
 * client-injected env was missing." With the key/base-url gone from the client,
 * the client can no longer observe a missing env — that is now a server concern.
 * The cockpit only enters TriStar mode when /api/auth/me reports
 * tristar.configured === true (App.jsx), and a server that loses its env
 * mid-session returns 503 from the proxy (surfaced as an ApiAuthError-adjacent
 * ops error, not a silent local write). So TARGETS is just {LOCAL, TRISTAR}.
 *
 * --- header-merge contract ---
 *
 * resolveRoute / getApiConfig return an `applyHeaders(extra)` function rather
 * than a plain `headers` object. Post-stet the proxy injects auth server-side,
 * so applyHeaders is the identity merge (returns a fresh copy of `extra`). The
 * function shape is preserved so api.js's call sites and its X-Cockpit-Mode
 * merge order are unchanged, and so a future per-request header need has a
 * single chokepoint.
 *
 * --- pure, injectable ---
 *
 * No process.env / import.meta.env reads here. Mode is injected by the caller
 * (api.js, from /me). Keeps tests deterministic and lets the server jest config
 * exercise the same code as the browser without a Vite shim.
 */

export const MODES = Object.freeze({
  JORUVA: 'joruva',
  TRISTAR: 'tristar',
});

/**
 * Resolved-target enum. {LOCAL, TRISTAR} only — see the "no DEGRADED" note
 * above. LOCAL → nucleus-phone /api/<path>; TRISTAR → same-origin proxy
 * /api/tristar/<path>.
 */
export const TARGETS = Object.freeze({
  LOCAL: 'local',
  TRISTAR: 'tristar',
});

/** Same-origin prefix the server-side proxy is mounted at (server/index.js). */
export const TRISTAR_PROXY_PREFIX = '/api/tristar';

/**
 * Paths that, in TriStar mode, route through the proxy instead of the local
 * /api/ surface. Frozen so a mutation throws — widening/narrowing this set
 * silently would relax the no-local-writes contract. Downstream code must not
 * depend on order.
 */
export const ROUTED_PATHS = Object.freeze([
  '/queue',
  '/call/initiate',
  '/call/:id/disposition',
  '/token',
]);

/**
 * Escape regex metacharacters in a literal string. Standard recipe, so a future
 * ROUTED_PATHS entry containing '.', '+', '?', etc. does not become a wildcard.
 */
function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a path template (with :param segments) to an anchored regex.
 * Each :name becomes [^/]+ (single segment); both ends anchored so '/queue'
 * does not match '/queue/extra' and '/call/initiate.json' does not match
 * '/call/initiate'.
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

// Derived from ROUTED_PATHS at module load. Safe to keep separate because
// ROUTED_PATHS is frozen — no mutation can drift the two apart at runtime.
const ROUTED_PATH_REGEXES = ROUTED_PATHS.map(compilePathTemplate);

/**
 * True iff the path matches one of the routed-path templates.
 *
 * @param {string} path — request path WITHOUT the /api prefix (e.g.,
 *   '/queue', '/call/initiate', '/call/abc-123/disposition').
 */
export function isPathRouted(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  return ROUTED_PATH_REGEXES.some((re) => re.test(path));
}

/**
 * True iff the user is permitted to flip into TriStar mode. The bead spec gates
 * v1 to Britt/Blake/Tom; the caller supplies the allowlist (from server-driven
 * config so the gate changes without a redeploy). This module does not hardcode
 * identities. Returns false defensively on missing user, empty identity, empty
 * allowlist, or shape mismatch — TriStar mode stays opt-in.
 *
 * Note: this is a UI affordance gate only. The authoritative server-side gate
 * is tristarGate on /api/tristar/* (server/middleware/auth.js) — a forged
 * client cannot reach TriStar's API by lying here.
 */
export function canUseTriStarMode(user, allowedIdentities) {
  if (!user || typeof user.identity !== 'string' || user.identity.length === 0) return false;
  if (!Array.isArray(allowedIdentities) || allowedIdentities.length === 0) return false;
  return allowedIdentities.includes(user.identity);
}

/**
 * True iff opts requests TriStar mode. Tolerates null/undefined opts.
 */
function wantsTristar(opts) {
  return Boolean(opts && typeof opts === 'object' && opts.mode === MODES.TRISTAR);
}

/**
 * Build the applyHeaders function. Post-stet the proxy injects auth
 * server-side, so this is the identity merge — returns a FRESH object on every
 * invocation (safe under concurrent in-flight fetches; mutating the result
 * affects only that caller).
 */
function makeApplyHeaders() {
  return (extra = {}) => ({ ...extra });
}

/**
 * Resolve a request path to a fully-qualified-relative URL, target, and header
 * merger, given the current mode.
 *
 *   {
 *     url: string,                       // '/api/tristar/queue' | '/api/queue'
 *     target: 'local' | 'tristar',
 *     applyHeaders: (extra) => mergedHeaders,
 *   }
 *
 * Behavior matrix:
 *   mode=JORUVA, any path:              → LOCAL  (/api/<path>)
 *   mode=TRISTAR, path routed:          → TRISTAR (/api/tristar/<path>)
 *   mode=TRISTAR, path NOT routed:      → LOCAL  (/api/<path>)
 */
export function resolveRoute(path, opts) {
  if (wantsTristar(opts) && isPathRouted(path)) {
    return {
      url: `${TRISTAR_PROXY_PREFIX}${path}`,
      target: TARGETS.TRISTAR,
      applyHeaders: makeApplyHeaders(),
    };
  }

  return {
    url: `/api${path}`,
    target: TARGETS.LOCAL,
    applyHeaders: makeApplyHeaders(),
  };
}

/**
 * Convenience: caller-side recipe for the base prefix + header merger without a
 * specific path. Useful for code paths that build URLs with dynamic query
 * strings. Returns the proxy prefix in TriStar mode, /api otherwise.
 */
export function getApiConfig(opts) {
  if (wantsTristar(opts)) {
    return {
      baseUrl: TRISTAR_PROXY_PREFIX,
      target: TARGETS.TRISTAR,
      applyHeaders: makeApplyHeaders(),
    };
  }

  return {
    baseUrl: '/api',
    target: TARGETS.LOCAL,
    applyHeaders: makeApplyHeaders(),
  };
}
