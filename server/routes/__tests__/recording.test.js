jest.mock('../../db', () => require('../../__tests__/helpers/mock-pool')());
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('undici', () => ({ request: jest.fn() }));

const { Readable } = require('stream');
const { createHmac } = require('crypto');
const supertest = require('supertest');
const { listenLoopback, closeLoopbackServers } = require('../../__tests__/supertest-loopback.js');

afterEach(closeLoopbackServers);
const express = require('express');
const jwt = require('jsonwebtoken');
const { request: undiciRequest } = require('undici');
const { pool } = require('../../db');
const { __testSetUser } = require('../../middleware/auth');

const SIGNING_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TWILIO_SID = 'ACtestsid';
const TWILIO_TOKEN = 'testtoken';
const TWILIO_RECORDING_URL = 'https://api.twilio.com/2010-04-01/Accounts/ACtestsid/Recordings/RE123';

function sign(callId, userId, exp) {
  return createHmac('sha256', SIGNING_KEY)
    .update(`${callId}|${userId}|${exp}`)
    .digest('hex');
}

let nextUserId = 5000;
function mockBearer(identity, role = 'caller') {
  const id = nextUserId++;
  __testSetUser({
    id,
    email: `${identity}@joruva.com`,
    identity,
    role,
    displayName: identity,
  });
  jwt.verify.mockReturnValue({ userId: id });
  return { id, identity, role };
}

function mockTwilioResponse({ statusCode = 200, headers = {}, body = Buffer.from('') } = {}) {
  const stream = Readable.from([body]);
  stream.dump = jest.fn();
  undiciRequest.mockResolvedValueOnce({ statusCode, headers, body: stream });
  return stream;
}

let app;
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.RECORDING_SIGNING_KEY = SIGNING_KEY;
  process.env.TWILIO_ACCOUNT_SID = TWILIO_SID;
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  process.env.APP_URL = 'https://nucleus-phone.test';
  app = express();
  app.use(express.json());
  app.use('/api/recording', require('../recording'));
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.RECORDING_SIGNING_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.APP_URL;
  delete process.env.RECORDING_MAX_BYTES;
});

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

/* ───────────── GET /:callId/signed-url ───────────── */

describe('GET /api/recording/:callId/signed-url', () => {
  test('401 without bearer token', async () => {
    await supertest(await listenLoopback(app)).get('/api/recording/42/signed-url').expect(401);
  });

  test('401 on invalid bearer JWT', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('bad jwt'); });
    await supertest(await listenLoopback(app))
      .get('/api/recording/42/signed-url')
      .set('Authorization', 'Bearer xxx')
      .expect(401);
  });

  test('returns signed URL on happy path (admin)', async () => {
    mockBearer('tom', 'admin');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });

    const res = await supertest(await listenLoopback(app))
      .get('/api/recording/42/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(200);

    expect(res.body.url).toMatch(/^https:\/\/nucleus-phone\.test\/api\/recording\/42\/stream\?t=[0-9a-f]{64}&exp=\d+&u=\d+$/);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(new Date(res.body.expiresAt).toString()).not.toBe('Invalid Date');

    const where = pool.query.mock.calls[0][1];
    expect(where).toEqual([42]);
  });

  test('non-admin caller filters by caller_identity', async () => {
    const user = mockBearer('kate', 'caller');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });

    await supertest(await listenLoopback(app))
      .get('/api/recording/42/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(200);

    const sql = pool.query.mock.calls[0][0];
    const params = pool.query.mock.calls[0][1];
    expect(sql).toContain('caller_identity');
    expect(params).toEqual([42, user.identity]);
  });

  test('404 when call not found (or not owned by non-admin)', async () => {
    mockBearer('kate', 'caller');
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await supertest(await listenLoopback(app))
      .get('/api/recording/999/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(404);
  });

  test('404 when recording_url is null', async () => {
    mockBearer('tom', 'admin');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, recording_url: null }],
      rowCount: 1,
    });

    await supertest(await listenLoopback(app))
      .get('/api/recording/42/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(404);
  });

  test('400 on non-integer callId', async () => {
    mockBearer('tom', 'admin');
    await supertest(await listenLoopback(app))
      .get('/api/recording/abc/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(400);
  });

  test('signed URL HMAC matches the canonical formula', async () => {
    const user = mockBearer('tom', 'admin');
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });

    const res = await supertest(await listenLoopback(app))
      .get('/api/recording/42/signed-url')
      .set('Authorization', 'Bearer ok')
      .expect(200);

    const url = new URL(res.body.url);
    const t = url.searchParams.get('t');
    const exp = parseInt(url.searchParams.get('exp'), 10);
    const u = parseInt(url.searchParams.get('u'), 10);
    expect(u).toBe(user.id);
    expect(sign(42, u, exp)).toBe(t);
  });
});

/* ───────────── GET /:callId/stream ───────────── */

describe('GET /api/recording/:callId/stream', () => {
  const userId = 7;
  const callId = 42;

  function streamUrl({ t, exp, u } = {}) {
    const params = new URLSearchParams();
    if (t !== undefined) params.set('t', t);
    if (exp !== undefined) params.set('exp', String(exp));
    if (u !== undefined) params.set('u', String(u));
    return `/api/recording/${callId}/stream?${params.toString()}`;
  }

  test('401 missing signature params', async () => {
    await supertest(await listenLoopback(app)).get(`/api/recording/${callId}/stream`).expect(401);
  });

  test('410 on expired exp', async () => {
    const exp = Math.floor(Date.now() / 1000) - 10;
    const t = sign(callId, userId, exp);
    await supertest(await listenLoopback(app)).get(streamUrl({ t, exp, u: userId })).expect(410);
  });

  test('401 on bad signature', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const badT = 'a'.repeat(64);
    await supertest(await listenLoopback(app)).get(streamUrl({ t: badT, exp, u: userId })).expect(401);
  });

  test('401 on tampered userId (HMAC will not match)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    // Substitute a different userId in the URL — server recomputes HMAC
    // with the URL's u value; mismatch → 401.
    await supertest(await listenLoopback(app)).get(streamUrl({ t, exp, u: userId + 1 })).expect(401);
  });

  test('401 on malformed signature (non-hex)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    await supertest(await listenLoopback(app)).get(streamUrl({ t: 'zzz', exp, u: userId })).expect(401);
  });

  test('happy path: 200 + audio/mpeg, appends .mp3 to Twilio URL', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });
    mockTwilioResponse({
      statusCode: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '4', 'accept-ranges': 'bytes' },
      body: Buffer.from('fake'),
    });

    const res = await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(200);

    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body.toString()).toBe('fake');

    const upstreamCall = undiciRequest.mock.calls[0];
    expect(upstreamCall[0]).toBe(`${TWILIO_RECORDING_URL}.mp3`);
    expect(upstreamCall[1].headers.Authorization).toMatch(/^Basic /);
  });

  test('forwards Range header and returns 206 + Content-Range', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });
    mockTwilioResponse({
      statusCode: 206,
      headers: {
        'content-type': 'audio/mpeg',
        'content-range': 'bytes 0-1023/4096',
        'content-length': '1024',
        'accept-ranges': 'bytes',
      },
      body: Buffer.alloc(1024, 'x'),
    });

    const res = await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .set('Range', 'bytes=0-1023')
      .expect(206);

    expect(res.headers['content-range']).toBe('bytes 0-1023/4096');
    expect(undiciRequest.mock.calls[0][1].headers.Range).toBe('bytes=0-1023');
  });

  test('502 when Twilio Content-Length exceeds RECORDING_MAX_BYTES', async () => {
    process.env.RECORDING_MAX_BYTES = '1024';
    try {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const t = sign(callId, userId, exp);
      pool.query.mockResolvedValueOnce({
        rows: [{ recording_url: TWILIO_RECORDING_URL }],
        rowCount: 1,
      });
      mockTwilioResponse({
        statusCode: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '999999' },
        body: Buffer.alloc(0),
      });

      await supertest(await listenLoopback(app))
        .get(streamUrl({ t, exp, u: userId }))
        .expect(502);
    } finally {
      delete process.env.RECORDING_MAX_BYTES;
    }
  });

  test('502 when Twilio returns 4xx/5xx', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });
    mockTwilioResponse({
      statusCode: 404,
      headers: {},
      body: Buffer.from('not found'),
    });

    await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(502);
  });

  test('502 when Twilio fetch throws', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });
    undiciRequest.mockRejectedValueOnce(new Error('ECONNRESET'));

    await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(502);
  });

  test('404 when call has no recording_url', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: null }],
      rowCount: 1,
    });

    await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(404);
  });

  test('404 when call_id row missing', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(404);
  });

  test('aborts mid-stream when chunked response (no content-length) exceeds cap', async () => {
    process.env.RECORDING_MAX_BYTES = '4';
    try {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const t = sign(callId, userId, exp);
      pool.query.mockResolvedValueOnce({
        rows: [{ recording_url: TWILIO_RECORDING_URL }],
        rowCount: 1,
      });
      // No content-length header → pre-check passes; oversize must trip
      // inside the streaming counter Transform, which destroys the socket.
      // supertest surfaces the destroy as a request error — assert that's
      // what we got, not a clean response.
      mockTwilioResponse({
        statusCode: 200,
        headers: { 'content-type': 'audio/mpeg' },
        body: Buffer.alloc(2048, 'x'),
      });

      let caught = null;
      try {
        await supertest(await listenLoopback(app)).get(streamUrl({ t, exp, u: userId }));
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(caught.message).toMatch(/socket hang up|aborted|premature/i);
    } finally {
      delete process.env.RECORDING_MAX_BYTES;
    }
  });

  test('forwards ETag and Last-Modified headers', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: TWILIO_RECORDING_URL }],
      rowCount: 1,
    });
    mockTwilioResponse({
      statusCode: 200,
      headers: {
        'content-type': 'audio/mpeg',
        etag: '"abc123"',
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      },
      body: Buffer.from('ok'),
    });

    const res = await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(200);

    expect(res.headers.etag).toBe('"abc123"');
    expect(res.headers['last-modified']).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });

  test('500 when TWILIO_ACCOUNT_SID missing', async () => {
    const original = process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_ACCOUNT_SID;
    try {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const t = sign(callId, userId, exp);
      pool.query.mockResolvedValueOnce({
        rows: [{ recording_url: TWILIO_RECORDING_URL }],
        rowCount: 1,
      });
      await supertest(await listenLoopback(app))
        .get(streamUrl({ t, exp, u: userId }))
        .expect(500);
    } finally {
      process.env.TWILIO_ACCOUNT_SID = original;
    }
  });

  test('does not double-append .mp3 if already present', async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const t = sign(callId, userId, exp);
    pool.query.mockResolvedValueOnce({
      rows: [{ recording_url: `${TWILIO_RECORDING_URL}.mp3` }],
      rowCount: 1,
    });
    mockTwilioResponse({ statusCode: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('') });

    await supertest(await listenLoopback(app))
      .get(streamUrl({ t, exp, u: userId }))
      .expect(200);

    expect(undiciRequest.mock.calls[0][0]).toBe(`${TWILIO_RECORDING_URL}.mp3`);
  });
});
