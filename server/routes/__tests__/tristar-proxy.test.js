/**
 * tristar-proxy.test.js — bead nucleus-phone-stet (P1).
 *
 * Covers the server-side TriStar proxy + tristarGate: allowlist gating,
 * closed-proxy path allowlist, key injection, body/query forwarding, no
 * caller-header leakage, and upstream error passthrough.
 *
 * sessionAuth is stubbed (sets req.user directly) so these tests exercise
 * tristarGate + the proxy in isolation without JWT/DB; sessionAuth itself is
 * covered by its own suites.
 */
const request = require('supertest');
const express = require('express');
const { tristarGate } = require('../../middleware/auth');

const BASE = 'https://nucleus-tristar.test/api';
const KEY = 'tristar-secret-key';

function buildApp(identity) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/tristar',
    (req, _res, next) => {
      req.user = { id: 1, identity, role: 'caller' };
      next();
    },
    tristarGate,
    require('../tristar-proxy')
  );
  return app;
}

function mockResponse(status, body, contentType = 'application/json') {
  return {
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
  };
}

let app;

beforeEach(() => {
  process.env.TRISTAR_ALLOWED_IDENTITIES = 'tom,britt,blake';
  process.env.TRISTAR_API_BASE_URL = BASE;
  process.env.TRISTAR_API_KEY = KEY;
  global.fetch = jest.fn().mockResolvedValue(mockResponse(200, { ok: true }));
  app = buildApp('tom');
});

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.TRISTAR_ALLOWED_IDENTITIES;
  delete process.env.TRISTAR_API_BASE_URL;
  delete process.env.TRISTAR_API_KEY;
});

describe('tristarGate', () => {
  test('403 when identity is not on TRISTAR_ALLOWED_IDENTITIES', async () => {
    const notAllowed = buildApp('mallory');
    await request(notAllowed).get('/api/tristar/queue').expect(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('allows an allowlisted identity through to the proxy', async () => {
    await request(app).get('/api/tristar/queue').expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('closed-proxy path allowlist', () => {
  test.each([
    ['/api/tristar/queue', 'get'],
    ['/api/tristar/call/initiate', 'post'],
    ['/api/tristar/call/abc-123/disposition', 'post'],
    ['/api/tristar/token', 'get'],
  ])('forwards routed path %s', async (path, method) => {
    await request(app)[method](path).expect(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    '/api/tristar/contacts',
    '/api/tristar/queue/extra',
    '/api/tristar/call/initiate.json',
    '/api/tristar/history/123/disposition',
    '/api/tristar/',
  ])('404s non-routed path %s without calling upstream', async (path) => {
    await request(app).get(path).expect(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Linus review 2026-06-21: the [^/]+ :id slot must not carry an encoded slash
  // or dot-segment that the upstream would decode into an extra path segment.
  // Literal '../' is normalized away by any HTTP client before the wire, so the
  // real vector is ENCODED traversal — an encoded slash/null in the :id slot
  // that the upstream would decode. Those must 400, not reach upstream.
  test.each([
    '/api/tristar/call/..%2f..%2fadmin/disposition',
    '/api/tristar/call/x%2Fy/disposition',
    '/api/tristar/call/%00/disposition',
  ])('400s percent-encoded traversal path %s without calling upstream', async (path) => {
    await request(app).get(path).expect(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('key injection + forwarding', () => {
  test('injects X-API-Key and forwards to TRISTAR_API_BASE_URL + subpath', async () => {
    await request(app).get('/api/tristar/queue').expect(200);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe(`${BASE}/queue`);
    expect(opts.headers['X-API-Key']).toBe(KEY);
    expect(opts.method).toBe('GET');
  });

  test('preserves the query string', async () => {
    await request(app).get('/api/tristar/queue?tier=hot&limit=5').expect(200);
    expect(global.fetch.mock.calls[0][0]).toBe(`${BASE}/queue?tier=hot&limit=5`);
  });

  test('forwards POST body re-serialized as JSON with Content-Type', async () => {
    await request(app)
      .post('/api/tristar/call/initiate')
      .send({ to: '+15551234567', contactName: 'Acme' })
      .expect(200);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ to: '+15551234567', contactName: 'Acme' });
  });

  test('a caller-supplied X-API-Key cannot override the injected server key', async () => {
    await request(app)
      .get('/api/tristar/queue')
      .set('X-API-Key', 'attacker-supplied')
      .set('X-Cockpit-Mode', 'tristar')
      .expect(200);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers['X-API-Key']).toBe(KEY);
    // The proxy builds a fresh header set — caller's X-Cockpit-Mode is not relayed.
    expect(opts.headers['X-Cockpit-Mode']).toBeUndefined();
  });

  test('does not forward cookies to the upstream', async () => {
    await request(app)
      .get('/api/tristar/queue')
      .set('Cookie', 'nucleus_session=abc')
      .expect(200);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Cookie).toBeUndefined();
    expect(opts.headers.cookie).toBeUndefined();
  });
});

describe('upstream response passthrough', () => {
  test('passes through upstream status + body verbatim', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse(201, { id: 'call_1' }));
    const res = await request(app).post('/api/tristar/call/initiate').send({}).expect(201);
    expect(res.body).toEqual({ id: 'call_1' });
  });

  test('passes through a 401 from upstream (rotated key)', async () => {
    global.fetch.mockResolvedValueOnce(mockResponse(401, { error: 'bad key' }));
    await request(app).get('/api/tristar/queue').expect(401);
  });
});

describe('misconfig + unreachable', () => {
  test('503 when TRISTAR_API_KEY is missing (no local fallback)', async () => {
    delete process.env.TRISTAR_API_KEY;
    await request(app).get('/api/tristar/queue').expect(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('503 when TRISTAR_API_BASE_URL is missing', async () => {
    delete process.env.TRISTAR_API_BASE_URL;
    await request(app).get('/api/tristar/queue').expect(503);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('502 when the upstream fetch throws', async () => {
    global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await request(app).get('/api/tristar/queue').expect(502);
  });
});
