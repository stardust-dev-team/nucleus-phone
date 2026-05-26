/**
 * api.js — client-side HTTP layer.
 *
 * Mode routing — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.b]:
 *
 * apiFetch routes through mode-router.resolveRoute so the cockpit can run
 * against nucleus-tristar's deployment for the three routed paths
 * (/queue, /call/initiate, /call/:id/disposition) while the rest of the
 * surface continues to hit nucleus-phone's local /api/. Module-level
 * config (configureApi) is set once at App.jsx boot after /api/auth/me
 * resolves — every existing caller of the exported functions below is
 * UNCHANGED. Consumers don't know the mode-router exists.
 *
 * DEGRADED resolutions (mode=TRISTAR but env missing) throw
 * ApiDegradedError WITHOUT firing fetch. A 'api:degraded' window event
 * is dispatched so DegradedBanner.jsx can surface the failure in the UI.
 * This is the no-local-writes contract enforced at the call site — the
 * anti-pattern test in __tests__/tristar-mode-no-local-writes.test.js
 * (line ~453) documents what NOT to do; this implementation refuses to
 * do it.
 *
 * v2 path (bead nucleus-phone-stet, P1): server-side proxy will replace
 * the cross-origin call. When that ships, configureApi's tristarBaseUrl
 * changes to a local prefix and tristarApiKey goes away — no consumer
 * surface change required. Don't bake cross-origin assumptions into
 * what consumers see.
 */

import { resolveRoute, TARGETS, MODES } from './mode-router.js';

let _modeConfig = {
  mode: MODES.JORUVA,
  tristarBaseUrl: null,
  tristarApiKey: null,
};

/**
 * Configure the mode-router for subsequent api.js calls. Call once at
 * App.jsx boot after the user session resolves. Idempotent — merges into
 * existing config so a partial update doesn't reset other fields.
 *
 * Inputs are taken on trust; mode-router itself validates the shape
 * (normalizeTristarBaseUrl rejects non-https, missing host, etc.) and
 * falls through to DEGRADED on bad config rather than throwing here. We
 * want misconfig to surface at request time, where the banner can fire,
 * not at boot where it would white-screen the cockpit.
 */
export function configureApi(next) {
  _modeConfig = { ..._modeConfig, ...next };
}

/**
 * Read-only snapshot of the current mode config. Tests and the
 * DegradedBanner read this to render mode-aware UI.
 */
export function getModeConfig() {
  return { ..._modeConfig };
}

/**
 * Thrown by apiFetch when mode-router resolves to TARGETS.DEGRADED. The
 * fetch is NEVER issued in this case — that's the no-local-writes
 * contract. Callers can test via instanceof; the class identity is the
 * stable surface (not the message string).
 */
export class ApiDegradedError extends Error {
  constructor(path) {
    super(`TriStar mode active but config missing — refusing to fetch ${path}`);
    this.name = 'ApiDegradedError';
    this.path = path;
  }
}

/**
 * Dispatch the degraded event on window so DegradedBanner.jsx (or any
 * other listener) can surface ops failure without prop-drilling through
 * every component. Guarded against SSR / non-browser environments where
 * window may be undefined.
 */
function notifyDegraded(path) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('api:degraded', {
    detail: { path, timestamp: Date.now() },
  }));
}

/**
 * Dispatch a "TriStar call succeeded" event so DegradedBanner.jsx can
 * auto-clear after the first ok TriStar response. Conservative: only
 * fires on TARGETS.TRISTAR + res.ok. A 500 from TriStar reaches its
 * server (proving URL+key are fine) but we'd rather wait for a clean
 * ok before declaring all-clear — avoids a false clear when
 * nucleus-tristar itself is degraded.
 */
function notifyTristarOk(path) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent('api:tristar-ok', {
    detail: { path, timestamp: Date.now() },
  }));
}

/**
 * apiFetch — internal fetch helper. Exported for tests that pin the
 * header-merge contract directly (caller-supplied X-API-Key /
 * X-Cockpit-Mode must NOT override the mode-driven values). Application
 * code should call one of the typed wrappers below — they're the
 * stable consumer surface and survive future refactors of apiFetch's
 * options shape.
 */
export async function apiFetch(path, options = {}) {
  const { signal, headers: callerHeaders, ...rest } = options;

  // Snapshot module config once at top. JS event-loop semantics protect
  // synchronous reads, but capturing once defends against a future
  // refactor that adds an `await` between reads and creates a real
  // TOCTOU. mode-router's `route` object already captures URL+target+
  // applyHeaders atomically; this snapshot guards the cockpitModeHeader
  // read below. Linus pass-1 P2-4 fix.
  const snapshot = _modeConfig;

  // Split path from query string before route resolution. mode-router's
  // ROUTED_PATH_REGEXES are anchored on the path-only (e.g., /^\/queue$/
  // does NOT match '/queue?limit=25'), so passing the full string would
  // miss the match and silently fall through to LOCAL. We re-attach the
  // query to the resolved URL below. The only routed path with a query
  // today is /queue (via getQueue); the split is cheap and future-proof.
  const qIdx = path.indexOf('?');
  const pathOnly = qIdx === -1 ? path : path.slice(0, qIdx);
  const queryString = qIdx === -1 ? '' : path.slice(qIdx);

  const route = resolveRoute(pathOnly, snapshot);
  const finalUrl = queryString ? `${route.url}${queryString}` : route.url;

  if (route.target === TARGETS.DEGRADED) {
    notifyDegraded(path);
    throw new ApiDegradedError(path);
  }

  // X-Cockpit-Mode is sent on EVERY request when the requested mode is
  // TriStar, not only routed ones. This is a latent capability for bead
  // nucleus-phone-kvje (P2) — when the server-side guard lands, it just
  // turns on; api.js needs no change. The header is harmless until then.
  const cockpitModeHeader = snapshot.mode === MODES.TRISTAR
    ? { 'X-Cockpit-Mode': 'tristar' }
    : {};

  // TriStar target is cross-origin; cookies don't apply and including
  // them triggers a CORS preflight that nucleus-tristar does not handle.
  // Local target uses session cookies via 'include'. DEGRADED can't
  // reach here (thrown above).
  const credentials = route.target === TARGETS.TRISTAR ? 'omit' : 'include';

  // Header merge order matters. Inside `extra`:
  //   1. Content-Type / X-Requested-With — defaults, callable can override
  //   2. callerHeaders                   — caller customization
  //   3. cockpitModeHeader               — mode-driven, MUST win over caller
  //                                        so kvje's server-side guard
  //                                        can't be downgraded client-side
  //                                        (Linus pass-1 P1-3 fix)
  // applyHeaders then spreads `extra` first, X-API-Key last — that's the
  // bboo invariant (mode-router.js:237-243, the qm0 lesson). Don't move
  // X-API-Key out of applyHeaders.
  const mergedHeaders = route.applyHeaders({
    'Content-Type': 'application/json',
    'X-Requested-With': 'fetch',
    ...callerHeaders,
    ...cockpitModeHeader,
  });

  const res = await fetch(finalUrl, {
    ...rest,
    credentials,
    signal,
    headers: mergedHeaders,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  // Parse body BEFORE dispatching ok event. A 200 response with a
  // malformed body is server-degraded the same way a 500 is — the
  // conservative auto-clear policy (docstring on notifyTristarOk) should
  // not declare all-clear until we have a clean JSON parse. Linus
  // pass-1 P2-5 fix.
  const body = await res.json();
  if (route.target === TARGETS.TRISTAR) {
    notifyTristarOk(path);
  }
  return body;
}

export function getToken(identity) {
  return apiFetch(`/token?identity=${encodeURIComponent(identity)}`);
}

export function initiateCall({ to, contactName, companyName, contactId, callerIdentity }) {
  return apiFetch('/call/initiate', {
    method: 'POST',
    body: JSON.stringify({ to, contactName, companyName, contactId, callerIdentity }),
  });
}

export function joinCall({ conferenceName, callerIdentity, muted }) {
  return apiFetch('/call/join', {
    method: 'POST',
    body: JSON.stringify({ conferenceName, callerIdentity, muted }),
  });
}

export function muteParticipant({ conferenceName, participantCallSid, muted }) {
  return apiFetch('/call/mute', {
    method: 'POST',
    body: JSON.stringify({ conferenceName, participantCallSid, muted }),
  });
}

export function getActiveCalls() {
  return apiFetch('/call/active');
}

export function endCall(conferenceName) {
  return apiFetch('/call/end', {
    method: 'POST',
    body: JSON.stringify({ conferenceName }),
  });
}

export function searchContacts(q, limit = 50) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  params.set('limit', limit);
  return apiFetch(`/contacts?${params}`);
}

export function getSignalContacts({ signal_tier, geo_state, timezone, has_phone = true, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (signal_tier) params.set('signal_tier', signal_tier);
  if (timezone) params.set('timezone', timezone);
  else if (geo_state) params.set('geo_state', geo_state);
  if (!has_phone) params.set('has_phone', 'false');
  params.set('limit', limit);
  params.set('offset', offset);
  return apiFetch(`/contacts/signal?${params}`);
}

export function getSignalCallbacks() {
  return apiFetch('/signals/callbacks');
}

export function getContact(id) {
  return apiFetch(`/contacts/${id}`);
}

// ── Activity (merged History + Notes) ───────────────────────
// Hits /api/history with the full param set: caller, FTS q, date range,
// disposition, qualification, hasSummary, pagination.
export function getActivity({
  caller,
  q,
  from,
  to,
  disposition,
  qualification,
  hasSummary,
  limit = 25,
  offset = 0,
  signal,
} = {}) {
  const params = new URLSearchParams();
  if (caller) params.set('caller', caller);
  if (q) params.set('q', q);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (disposition) params.set('disposition', disposition);
  if (qualification) params.set('qualification', qualification);
  if (hasSummary) params.set('hasSummary', 'true');
  params.set('limit', limit);
  params.set('offset', offset);
  return apiFetch(`/history?${params}`, { signal });
}

export function getCallDetail(id, { signal } = {}) {
  return apiFetch(`/history/${id}`, { signal });
}

export function getActivityTimeline(id, { signal } = {}) {
  return apiFetch(`/history/${id}/timeline`, { signal });
}

export function saveDisposition(callId, data) {
  return apiFetch(`/history/${callId}/disposition`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * TriStar-flavored disposition save — bead nucleus-phone-gxt2 /
 * stardust-tristar [coc.1.b]. Hits /call/:id/disposition (routed in
 * mode-router as ROUTED_PATHS[2]). In Joruva mode this still resolves
 * to TARGETS.LOCAL → /api/call/:id/disposition (which doesn't exist on
 * nucleus-phone and will 404) — DO NOT call this from Joruva-mode
 * code. The cockpit (bead nucleus-phone-e91e) picks between
 * saveDisposition (Joruva) and saveTristarDisposition (TriStar) per
 * mode at the call site.
 */
export function saveTristarDisposition(callId, data) {
  return apiFetch(`/call/${callId}/disposition`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * TriStar /queue — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.b].
 * Mode-router routes /queue to nucleus-tristar; no Joruva equivalent
 * exists. Calling this in Joruva mode resolves to TARGETS.LOCAL →
 * /api/queue (which doesn't exist and will 404). The cockpit only
 * renders the queue view (bead e91e) when in TriStar mode, so this
 * function is effectively TriStar-only by call-site discipline.
 *
 * Server-side defaults (nucleus-tristar/src/routes/queue.js:111-122):
 *   limit ≤ MAX_LIMIT (server-capped), default DEFAULT_LIMIT
 *   tier:  csv of 'warm' | 'hot'; default both. No offset support.
 */
export function getQueue({ limit, tier, signal } = {}) {
  const params = new URLSearchParams();
  if (Number.isFinite(limit) && limit > 0) params.set('limit', limit);
  if (typeof tier === 'string' && tier.length > 0) params.set('tier', tier);
  const qs = params.toString();
  return apiFetch(qs ? `/queue?${qs}` : '/queue', { signal });
}

export function getCockpit(identifier, signal, { difficulty } = {}) {
  const params = difficulty ? `?difficulty=${difficulty}` : '';
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}${params}`, { signal });
}

export function getNextUncalled(excludePhone, signal) {
  const params = excludePhone ? `?exclude=${encodeURIComponent(excludePhone)}` : '';
  return apiFetch(`/cockpit/next-uncalled${params}`, { signal });
}

export function refreshCockpit(identifier, signal, { difficulty } = {}) {
  const params = difficulty ? `?refresh=true&difficulty=${difficulty}` : '?refresh=true';
  return apiFetch(`/cockpit/${encodeURIComponent(identifier)}${params}`, { signal });
}

export function getScoreboard(signal) {
  return apiFetch('/scoreboard', { signal });
}

export function startPracticeCall(difficulty, mode = 'phone') {
  return apiFetch('/sim/call', {
    method: 'POST',
    body: JSON.stringify({ difficulty, mode }),
  });
}

export function getPracticeCallStatus(id, signal) {
  return apiFetch(`/sim/call/${id}/status`, { signal });
}

export function cancelPracticeCall(id) {
  return apiFetch(`/sim/call/${id}/cancel`, { method: 'POST' });
}

export function linkVapiCall(simCallId, vapiCallId) {
  return apiFetch(`/sim/call/${simCallId}/link-vapi`, {
    method: 'POST',
    body: JSON.stringify({ vapiCallId }),
  });
}

export function getSimListenUrl(simCallId) {
  return apiFetch(`/sim/call/${simCallId}/listen`);
}

export function getPracticeScores(identity) {
  return apiFetch(`/sim/scores/${encodeURIComponent(identity)}`);
}

export function getPracticeScoreboard(signal) {
  return apiFetch('/sim/scoreboard', { signal });
}

export function runTestScenario(chunks, delayMs = 800) {
  return apiFetch('/equipment/test-scenario', {
    method: 'POST',
    body: JSON.stringify({ chunks, delayMs }),
  });
}


// ── Ask Nucleus ──────────────────────────────────────────────
// askNucleus uses raw fetch (NOT apiFetch) because the response is an SSE
// stream and apiFetch calls res.json() unconditionally. The caller reads
// the stream via response.body.getReader(). SSE is always local — the
// Ask surface is not in ROUTED_PATHS and TriStar has no equivalent.
export function askNucleus({ message, conversationId, signal }) {
  return fetch('/api/ask', {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-Requested-With': 'fetch',
    },
    body: JSON.stringify({ message, conversationId: conversationId || null }),
  });
}

export function askNucleusEscalate({ question, context, company, contact, conversationId }) {
  return apiFetch('/ask/escalate', {
    method: 'POST',
    body: JSON.stringify({ question, context, company, contact, conversationId }),
  });
}

export function askNucleusGetConversation(id, { signal } = {}) {
  return apiFetch(`/ask/conversations/${id}`, { signal });
}

export function askNucleusListConversations({ signal } = {}) {
  return apiFetch('/ask/conversations', { signal });
}

export function askNucleusDeleteConversation(id) {
  return apiFetch(`/ask/conversations/${id}`, { method: 'DELETE' });
}
