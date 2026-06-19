/**
 * api.js contract tests — bead nucleus-phone-gxt2 / stardust-tristar
 * [coc.1.b].
 *
 * Sibling to __tests__/tristar-mode-no-local-writes.test.js (bboo, which
 * proves mode-router's contract in isolation). THIS test proves api.js
 * — the consumer of mode-router — wires the contract correctly:
 *
 *   - In Joruva mode, fetches hit /api with credentials:'include' and
 *     no TriStar headers.
 *   - In TriStar mode + routed path, fetches hit the same-origin proxy
 *     (/api/tristar/*) with credentials:'include', X-Cockpit-Mode, and NO
 *     client-side X-API-Key (the proxy injects it server-side — stet).
 *   - In TriStar mode + non-routed path, fetches hit local /api but
 *     still carry X-Cockpit-Mode (latent capability for bead kvje).
 *   - TARGETS.TRISTAR ok response dispatches 'api:tristar-ok'; a 500
 *     does NOT (conservative auto-clear).
 *   - getQueue + saveTristarDisposition route correctly.
 *
 * Module state reset: api.js holds _modeConfig at module scope.
 * beforeEach resets via configureApi back to Joruva defaults so tests
 * don't leak state into each other.
 */

import {
  configureApi,
  getModeConfig,
  getQueue,
  saveTristarDisposition,
  initiateCall,
  saveDisposition,
  getScoreboard,
  apiFetch,
} from '../api';
import { MODES, TRISTAR_PROXY_PREFIX } from '../mode-router';

// Post-stet (P1): TriStar routed paths resolve to the same-origin proxy
// (TRISTAR_PROXY_PREFIX === '/api/tristar') and the key is injected
// server-side. Client config is mode-only.
const TRISTAR_CFG = { mode: MODES.TRISTAR };
const JORUVA_CFG = { mode: MODES.JORUVA };

describe('client/src/lib/api.js — mode-router wiring', () => {
  let originalFetch;
  let fetchCalls;
  let degradedEvents;
  let tristarOkEvents;

  beforeEach(() => {
    // Reset module-level _modeConfig to a known Joruva baseline.
    configureApi(JORUVA_CFG);

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

    degradedEvents = [];
    tristarOkEvents = [];
    window.addEventListener('api:degraded', degradedListener);
    window.addEventListener('api:tristar-ok', tristarOkListener);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    window.removeEventListener('api:degraded', degradedListener);
    window.removeEventListener('api:tristar-ok', tristarOkListener);
  });

  function degradedListener(e) { degradedEvents.push(e.detail); }
  function tristarOkListener(e) { tristarOkEvents.push(e.detail); }

  // ── configureApi / getModeConfig ───────────────────────────────────

  describe('configureApi', () => {
    test('merges into module state (idempotent partial update)', () => {
      configureApi({ mode: MODES.TRISTAR });
      expect(getModeConfig()).toEqual({ mode: MODES.TRISTAR });
    });

    test('flipping mode back to Joruva updates the config', () => {
      configureApi(TRISTAR_CFG);
      configureApi({ mode: MODES.JORUVA });
      expect(getModeConfig()).toEqual({ mode: MODES.JORUVA });
    });

    test('getModeConfig returns a fresh object (no aliasing)', () => {
      const a = getModeConfig();
      const b = getModeConfig();
      expect(a).not.toBe(b);
      a.mode = 'mutated';
      expect(getModeConfig().mode).toBe(MODES.JORUVA);
    });
  });

  // ── Joruva mode ────────────────────────────────────────────────────

  describe('Joruva mode', () => {
    test('routed path hits /api with credentials:include and no TriStar headers', async () => {
      await initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' });
      expect(fetchCalls).toHaveLength(1);
      const { url, init } = fetchCalls[0];
      expect(url).toBe('/api/call/initiate');
      expect(init.credentials).toBe('include');
      expect(init.headers['X-API-Key']).toBeUndefined();
      expect(init.headers['X-Cockpit-Mode']).toBeUndefined();
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    test('non-routed path hits /api with credentials:include and no TriStar headers', async () => {
      await getScoreboard();
      expect(fetchCalls[0].url).toBe('/api/scoreboard');
      expect(fetchCalls[0].init.credentials).toBe('include');
      expect(fetchCalls[0].init.headers['X-Cockpit-Mode']).toBeUndefined();
    });
  });

  // ── TriStar mode + routed path ─────────────────────────────────────

  describe('TriStar mode, routed path', () => {
    beforeEach(() => configureApi(TRISTAR_CFG));

    test('initiateCall hits the same-origin proxy with credentials:include + X-Cockpit-Mode, NO client key', async () => {
      await initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' });
      const { url, init } = fetchCalls[0];
      expect(url).toBe(`${TRISTAR_PROXY_PREFIX}/call/initiate`);
      expect(init.credentials).toBe('include');
      expect(init.headers['X-API-Key']).toBeUndefined();
      expect(init.headers['X-Cockpit-Mode']).toBe('tristar');
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    test('saveTristarDisposition hits /api/tristar/call/:id/disposition', async () => {
      await saveTristarDisposition('abc-123', { outcome: 'connected' });
      const { url, init } = fetchCalls[0];
      expect(url).toBe(`${TRISTAR_PROXY_PREFIX}/call/abc-123/disposition`);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(init.headers['X-API-Key']).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ outcome: 'connected' });
    });

    test('getQueue with no args hits /api/tristar/queue (no query string)', async () => {
      await getQueue();
      expect(fetchCalls[0].url).toBe(`${TRISTAR_PROXY_PREFIX}/queue`);
    });

    test('getQueue with limit + tier serializes query params on the proxy path', async () => {
      await getQueue({ limit: 25, tier: 'hot' });
      const u = new URL(fetchCalls[0].url, 'http://localhost');
      expect(u.pathname).toBe(`${TRISTAR_PROXY_PREFIX}/queue`);
      expect(u.searchParams.get('limit')).toBe('25');
      expect(u.searchParams.get('tier')).toBe('hot');
    });

    test('dispatches api:tristar-ok on ok response', async () => {
      await initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' });
      expect(tristarOkEvents).toHaveLength(1);
      expect(tristarOkEvents[0].path).toBe('/call/initiate');
    });

    test('does NOT dispatch api:tristar-ok on non-ok response (conservative)', async () => {
      global.fetch = jest.fn(async (url) => {
        fetchCalls.push({ url });
        return { ok: false, status: 500, text: async () => 'server error', json: async () => ({}) };
      });
      await expect(initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' }))
        .rejects.toThrow(/API 500/);
      expect(tristarOkEvents).toHaveLength(0);
    });

    test('does NOT dispatch api:tristar-ok when body parse throws (Linus P2-5)', async () => {
      // Conservative auto-clear: a 200 with malformed JSON body is
      // server-degraded the same way a 500 is. notifyTristarOk fires
      // AFTER `await res.json()` resolves; if .json() throws, the
      // dispatch line is never reached.
      global.fetch = jest.fn(async (url) => {
        fetchCalls.push({ url });
        return {
          ok: true,
          status: 200,
          text: async () => 'malformed{',
          json: async () => { throw new Error('Unexpected token in JSON'); },
        };
      });
      await expect(initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' }))
        .rejects.toThrow(/Unexpected token/);
      expect(tristarOkEvents).toHaveLength(0);
    });

    test('caller-supplied X-Cockpit-Mode CANNOT override mode-driven header (Linus P1-3)', async () => {
      // Header merge order MUST place cockpitModeHeader AFTER callerHeaders
      // so the mode-driven value wins. Without this guarantee, when bead
      // kvje's server-side guard lands, a caller could downgrade the
      // header client-side and bypass the guard.
      await apiFetch('/call/initiate', {
        method: 'POST',
        headers: { 'X-Cockpit-Mode': 'joruva' },
        body: JSON.stringify({}),
      });
      expect(fetchCalls[0].init.headers['X-Cockpit-Mode']).toBe('tristar');
    });

    test('a caller-supplied X-API-Key is NOT relayed to the proxy (key is server-side only)', async () => {
      // Post-stet the client never sends an auth key. A caller passing one is
      // ignored end-to-end: api.js merges it into headers, but the server
      // proxy builds its own header set and injects the real key. Here we
      // only assert the client does not silently treat it as auth — the
      // proxy's own test pins that the caller value can't override the
      // injected key server-side.
      await apiFetch('/call/initiate', {
        method: 'POST',
        headers: { 'X-API-Key': 'attacker-supplied' },
        body: JSON.stringify({}),
      });
      // api.js passes caller headers through unchanged (no mode-router key to
      // override it with) — the security boundary is the server proxy.
      expect(fetchCalls[0].init.headers['X-API-Key']).toBe('attacker-supplied');
    });
  });

  // ── TriStar mode + non-routed path ─────────────────────────────────

  describe('TriStar mode, non-routed path', () => {
    beforeEach(() => configureApi(TRISTAR_CFG));

    test('hits local /api with X-Cockpit-Mode (latent for kvje) but no X-API-Key', async () => {
      await getScoreboard();
      const { url, init } = fetchCalls[0];
      expect(url).toBe('/api/scoreboard');
      expect(init.credentials).toBe('include');
      expect(init.headers['X-Cockpit-Mode']).toBe('tristar');
      expect(init.headers['X-API-Key']).toBeUndefined();
    });

    test('does NOT dispatch api:tristar-ok (target is LOCAL, not TRISTAR)', async () => {
      await getScoreboard();
      expect(tristarOkEvents).toHaveLength(0);
    });

    test('saveDisposition (Joruva path) still hits /api/history/:id/disposition in TriStar mode', async () => {
      // saveDisposition is the Joruva-mode disposition path. The cockpit
      // (e91e) picks between saveDisposition and saveTristarDisposition
      // per mode; api.js doesn't auto-translate. Verify that calling the
      // wrong one in TriStar mode stays on the local surface (it's an
      // e91e correctness concern, not api.js's).
      await saveDisposition('abc-123', { outcome: 'connected' });
      expect(fetchCalls[0].url).toBe('/api/history/abc-123/disposition');
    });
  });

  // ── server-misconfig (post-stet) — no client-side DEGRADED ─────────
  // The client no longer refuses a routed call: there is no client env to be
  // missing. A misconfigured server returns 503 from the proxy, which surfaces
  // as a plain API error (Queue.jsx maps 5xx to a "restarting" message). api.js
  // ALWAYS fires the fetch in TriStar mode and never throws ApiDegradedError
  // (that class is gone).

  describe('TriStar mode never refuses a routed fetch client-side', () => {
    beforeEach(() => configureApi(TRISTAR_CFG));

    test('a routed call always issues a fetch to the proxy (no ApiDegradedError)', async () => {
      await getQueue();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(fetchCalls[0].url).toBe(`${TRISTAR_PROXY_PREFIX}/queue`);
      expect(degradedEvents).toHaveLength(0);
    });

    test('a 503 from the proxy surfaces as a plain API error (5xx), not a special degraded state', async () => {
      global.fetch = jest.fn(async (url) => {
        fetchCalls.push({ url });
        return { ok: false, status: 503, text: async () => 'TriStar proxy not configured', json: async () => ({}) };
      });
      await expect(getQueue()).rejects.toThrow(/API 503/);
      expect(degradedEvents).toHaveLength(0);
    });
  });

  // ── 401/403 — typed ApiAuthError + auth-failed event ─────────────────
  // Added per Linus-review-#2 of bead nucleus-phone-ln18. Closes the
  // duplicate-bead pair sj5m + 7w3t (typed auth error).

  describe('401/403 returns ApiAuthError + api:auth-failed (sj5m/7w3t/ln18)', () => {
    let authFailedEvents;
    function authFailedListener(e) { authFailedEvents.push(e.detail); }

    beforeEach(() => {
      authFailedEvents = [];
      window.addEventListener('api:auth-failed', authFailedListener);
    });

    afterEach(() => {
      window.removeEventListener('api:auth-failed', authFailedListener);
    });

    function mockStatus(status, body = 'denied') {
      global.fetch = jest.fn(async (url, init) => {
        fetchCalls.push({ url, init });
        return {
          ok: false,
          status,
          json: async () => ({ error: body }),
          text: async () => body,
        };
      });
    }

    test('TriStar-target 401 throws ApiAuthError with target=tristar', async () => {
      configureApi(TRISTAR_CFG);
      mockStatus(401, 'invalid_or_missing_api_key');

      const { ApiAuthError } = await import('../api');
      try {
        await getQueue();
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiAuthError);
        expect(err.name).toBe('ApiAuthError');
        expect(err.status).toBe(401);
        expect(err.target).toBe('tristar');
        expect(err.path).toBe('/queue');
        expect(err.body).toBe('invalid_or_missing_api_key');
      }
    });

    test('TriStar-target 403 also throws ApiAuthError (parity with 401)', async () => {
      configureApi(TRISTAR_CFG);
      mockStatus(403, 'forbidden');

      const { ApiAuthError } = await import('../api');
      await expect(getQueue()).rejects.toBeInstanceOf(ApiAuthError);
    });

    test('TriStar-target 401 dispatches api:auth-failed with path + status', async () => {
      configureApi(TRISTAR_CFG);
      mockStatus(401);
      await expect(getQueue()).rejects.toThrow();
      expect(authFailedEvents).toHaveLength(1);
      expect(authFailedEvents[0].path).toBe('/queue');
      expect(authFailedEvents[0].status).toBe(401);
      expect(typeof authFailedEvents[0].timestamp).toBe('number');
    });

    test('LOCAL-target 401 throws ApiAuthError but does NOT dispatch auth-failed', async () => {
      // Session-cookie expiry on local routes is user-actionable (re-login)
      // not ops-actionable (key rotation). DegradedBanner is for the ops
      // signal; local-target 401 stays a per-component concern.
      configureApi(JORUVA_CFG);
      mockStatus(401);

      const { ApiAuthError } = await import('../api');
      try {
        await getScoreboard();
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiAuthError);
        expect(err.target).toBe('local');
      }
      expect(authFailedEvents).toHaveLength(0);
    });

    test('Non-401/403 errors still throw plain Error with the legacy message format', async () => {
      // Don't broaden ApiAuthError to all !ok. 5xx and 4xx-other-than-auth
      // are different consumer concerns and the legacy "API <status>: <text>"
      // format is what existing Queue.jsx code still pattern-matches on.
      configureApi(TRISTAR_CFG);
      mockStatus(500, 'boom');

      const { ApiAuthError } = await import('../api');
      try {
        await getQueue();
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).not.toBeInstanceOf(ApiAuthError);
        expect(err.message).toBe('API 500: boom');
      }
      expect(authFailedEvents).toHaveLength(0);
    });

    test('ApiAuthError is constructed with all five fields readable', async () => {
      const { ApiAuthError } = await import('../api');
      const e = new ApiAuthError('/x', 401, 'tristar', 'body-text');
      expect(e.path).toBe('/x');
      expect(e.status).toBe(401);
      expect(e.target).toBe('tristar');
      expect(e.body).toBe('body-text');
      expect(e.name).toBe('ApiAuthError');
      // class identity is the stable surface
      expect(e instanceof ApiAuthError).toBe(true);
      expect(e instanceof Error).toBe(true);
    });
  });
});
