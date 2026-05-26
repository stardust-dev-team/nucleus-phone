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
 *   - In TriStar mode + routed path, fetches hit the TriStar base URL
 *     with credentials:'omit', X-API-Key (last), and X-Cockpit-Mode.
 *   - In TriStar mode + non-routed path, fetches hit local /api but
 *     still carry X-Cockpit-Mode (latent capability for bead kvje).
 *   - DEGRADED state THROWS ApiDegradedError, dispatches 'api:degraded',
 *     and NEVER calls fetch (the no-local-writes guarantee at the call
 *     site).
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
  ApiDegradedError,
  getQueue,
  saveTristarDisposition,
  initiateCall,
  saveDisposition,
  getScoreboard,
  apiFetch,
} from '../api';
import { MODES } from '../mode-router';

const TRISTAR_BASE = 'https://nucleus-tristar.example';
const TRISTAR_KEY = 'k_test_shared_v1';

const TRISTAR_CFG = {
  mode: MODES.TRISTAR,
  tristarBaseUrl: TRISTAR_BASE,
  tristarApiKey: TRISTAR_KEY,
};

const JORUVA_CFG = {
  mode: MODES.JORUVA,
  tristarBaseUrl: null,
  tristarApiKey: null,
};

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
      configureApi({ tristarBaseUrl: TRISTAR_BASE });
      configureApi({ tristarApiKey: TRISTAR_KEY });
      expect(getModeConfig()).toEqual(TRISTAR_CFG);
    });

    test('partial update does not reset other fields', () => {
      configureApi(TRISTAR_CFG);
      configureApi({ mode: MODES.JORUVA });
      // baseUrl + key are still set; only mode flipped.
      expect(getModeConfig()).toEqual({
        mode: MODES.JORUVA,
        tristarBaseUrl: TRISTAR_BASE,
        tristarApiKey: TRISTAR_KEY,
      });
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

    test('initiateCall hits TriStar URL with credentials:omit + X-API-Key + X-Cockpit-Mode', async () => {
      await initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' });
      const { url, init } = fetchCalls[0];
      expect(url).toBe(`${TRISTAR_BASE}/call/initiate`);
      expect(init.credentials).toBe('omit');
      expect(init.headers['X-API-Key']).toBe(TRISTAR_KEY);
      expect(init.headers['X-Cockpit-Mode']).toBe('tristar');
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    test('saveTristarDisposition hits /call/:id/disposition on TriStar', async () => {
      await saveTristarDisposition('abc-123', { outcome: 'connected' });
      const { url, init } = fetchCalls[0];
      expect(url).toBe(`${TRISTAR_BASE}/call/abc-123/disposition`);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('omit');
      expect(init.headers['X-API-Key']).toBe(TRISTAR_KEY);
      expect(JSON.parse(init.body)).toEqual({ outcome: 'connected' });
    });

    test('getQueue with no args hits /queue (no query string)', async () => {
      await getQueue();
      expect(fetchCalls[0].url).toBe(`${TRISTAR_BASE}/queue`);
    });

    test('getQueue with limit + tier serializes query params', async () => {
      await getQueue({ limit: 25, tier: 'hot' });
      const u = new URL(fetchCalls[0].url);
      expect(u.origin + u.pathname).toBe(`${TRISTAR_BASE}/queue`);
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

    test('caller-supplied X-API-Key CANNOT override mode-driven key', async () => {
      // applyHeaders puts X-API-Key LAST. Caller cannot squash the
      // mode-router's auth key by passing their own. bboo invariant
      // pinned at the api.js boundary.
      await apiFetch('/call/initiate', {
        method: 'POST',
        headers: { 'X-API-Key': 'attacker-supplied' },
        body: JSON.stringify({}),
      });
      expect(fetchCalls[0].init.headers['X-API-Key']).toBe(TRISTAR_KEY);
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

  // ── DEGRADED state — the no-local-writes call-site guarantee ───────

  describe('DEGRADED target — refuses fetch + dispatches event', () => {
    beforeEach(() => {
      // TriStar requested, but baseUrl/key missing → DEGRADED for routed paths.
      configureApi({ mode: MODES.TRISTAR, tristarBaseUrl: null, tristarApiKey: null });
    });

    test('throws ApiDegradedError on a routed path', async () => {
      await expect(
        initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' })
      ).rejects.toThrow(ApiDegradedError);
    });

    test('the thrown error is instanceof ApiDegradedError (class identity, not message match)', async () => {
      try {
        await initiateCall({ to: '+15555550100', contactName: 'X', companyName: 'Y', contactId: 'c1', callerIdentity: 'tom' });
        throw new Error('expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiDegradedError);
        expect(err.name).toBe('ApiDegradedError');
        expect(err.path).toBe('/call/initiate');
      }
    });

    test('NEVER calls fetch when target resolves to DEGRADED', async () => {
      await expect(getQueue()).rejects.toThrow(ApiDegradedError);
      await expect(
        saveTristarDisposition('abc-123', { outcome: 'connected' })
      ).rejects.toThrow(ApiDegradedError);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('dispatches api:degraded with path + timestamp', async () => {
      await expect(getQueue()).rejects.toThrow();
      expect(degradedEvents).toHaveLength(1);
      expect(degradedEvents[0].path).toBe('/queue');
      expect(typeof degradedEvents[0].timestamp).toBe('number');
    });

    test('non-routed paths in DEGRADED-config mode still resolve to LOCAL (no throw)', async () => {
      // resolveRoute returns LOCAL when the path is NOT routed even if
      // mode === TRISTAR (DEGRADED is scoped to routed paths). Verifies
      // api.js doesn't over-broaden the throw.
      await getScoreboard();
      expect(fetchCalls[0].url).toBe('/api/scoreboard');
      expect(degradedEvents).toHaveLength(0);
    });
  });
});
