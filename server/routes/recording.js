/**
 * recording.js — signed-URL issuance + Twilio recording stream proxy.
 *
 * Two endpoints, distinct trust boundaries:
 *
 *   GET /:callId/signed-url  — bearerAuth + rbac + ownership check.
 *     Issues a short-lived HMAC-signed URL pointing at /:callId/stream.
 *
 *   GET /:callId/stream      — no middleware. The HMAC IS the auth.
 *     Validates the signature, looks up the Twilio recording URL, proxies
 *     the bytes with Twilio basic auth, forwards Range headers for seek.
 *     We do NOT re-check ownership here — AVPlayer issues many range
 *     requests per playback and re-validating per-byte would be wasteful.
 *     Defense in depth lives at signing time, not on every range fetch.
 *
 * Why userId is in the URL (?u=...): the HMAC payload is
 * `callId|userId|exp`, so the verifier needs userId. Including it in the
 * query string lets the stream route verify without a DB lookup. It's an
 * internal numeric id (no PII), and the HMAC binding still prevents
 * substitution — without RECORDING_SIGNING_KEY you can't forge a matching
 * signature for any (callId, userId, exp) triple.
 */

const { Router } = require('express');
const { createHmac, timingSafeEqual } = require('crypto');
const { Transform, pipeline } = require('stream');
const { request } = require('undici');
const { pool } = require('../db');
const { bearerAuth } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');

const router = Router();

const SIGNED_URL_TTL_SECONDS = 5 * 60;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024; // 200MB

function getMaxBytes() {
  const raw = process.env.RECORDING_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function dumpBody(body) {
  if (typeof body?.dump === 'function') body.dump();
  else body?.destroy?.();
}

function getSigningKey() {
  const key = process.env.RECORDING_SIGNING_KEY;
  if (!key) throw new Error('RECORDING_SIGNING_KEY not configured');
  return key;
}

function computeSignature(callId, userId, exp) {
  return createHmac('sha256', getSigningKey())
    .update(`${callId}|${userId}|${exp}`)
    .digest('hex');
}

function verifySignature(callId, userId, exp, signature) {
  let expected;
  try {
    expected = computeSignature(callId, userId, exp);
  } catch {
    return false;
  }
  const sigBuf = Buffer.from(String(signature), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  try {
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// GET /api/recording/:callId/signed-url
router.get('/:callId/signed-url', bearerAuth, rbac('external_caller'), async (req, res) => {
  const callId = parseInt(req.params.callId, 10);
  if (isNaN(callId)) return res.status(400).json({ error: 'callId must be an integer' });

  const where = ['id = $1'];
  const params = [callId];
  if (req.user.role !== 'admin') {
    where.push(`caller_identity = $${params.length + 1}`);
    params.push(req.user.identity);
  }

  let row;
  try {
    const result = await pool.query(
      `SELECT id, recording_url FROM nucleus_phone_calls WHERE ${where.join(' AND ')}`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    row = result.rows[0];
  } catch (err) {
    console.error('[recording] signed-url lookup failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!row.recording_url) return res.status(404).json({ error: 'No recording for this call' });

  const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;

  let signature;
  try {
    signature = computeSignature(callId, req.user.id, exp);
  } catch (err) {
    console.error('[recording] signing failed:', err.message);
    return res.status(500).json({ error: 'Signing not configured' });
  }

  const baseUrl = process.env.APP_URL || 'https://nucleus-phone.onrender.com';
  const url = `${baseUrl}/api/recording/${callId}/stream?t=${signature}&exp=${exp}&u=${req.user.id}`;

  res.json({ url, expiresAt: new Date(exp * 1000).toISOString() });
});

// GET /api/recording/:callId/stream
router.get('/:callId/stream', async (req, res) => {
  const callId = parseInt(req.params.callId, 10);
  if (isNaN(callId)) return res.status(400).json({ error: 'callId must be an integer' });

  const { t, exp, u } = req.query;
  if (!t || !exp || !u) return res.status(401).json({ error: 'Missing signature' });

  const expNum = parseInt(exp, 10);
  const userIdNum = parseInt(u, 10);
  if (isNaN(expNum) || isNaN(userIdNum)) {
    return res.status(401).json({ error: 'Invalid signature params' });
  }

  if (Math.floor(Date.now() / 1000) > expNum) {
    return res.status(410).json({ error: 'Signed URL expired' });
  }

  if (!verifySignature(callId, userIdNum, expNum, t)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let recordingUrl;
  try {
    const result = await pool.query(
      `SELECT recording_url FROM nucleus_phone_calls WHERE id = $1`,
      [callId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Call not found' });
    recordingUrl = result.rows[0].recording_url;
  } catch (err) {
    console.error('[recording] stream lookup failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  if (!recordingUrl) return res.status(404).json({ error: 'No recording' });

  // Twilio's RecordingUrl serves JSON metadata at the bare URL; append .mp3
  // to get the audio bytes.
  const twilioUrl = recordingUrl.endsWith('.mp3')
    ? recordingUrl
    : `${recordingUrl}.mp3`;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    console.error('[recording] Twilio credentials not configured');
    return res.status(500).json({ error: 'Recording proxy not configured' });
  }
  const basicAuth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  const upstreamHeaders = { Authorization: basicAuth };
  // We forward the client's Range upstream and forward Twilio's status +
  // accept-ranges/content-range back verbatim (see the header loop below), so
  // this proxy is fully transparent to range requests. HOWEVER: Twilio's
  // api.twilio.com Recordings .mp3 endpoint does NOT honor Range — it answers
  // 200 + `Accept-Ranges: none` and sends the whole body even when a Range is
  // present (verified 2026-06-10 against a live recording with the production
  // token: GET w/ `Range: bytes=0-1023` → 200, accept-ranges:none, full file).
  // So clients never get a 206 here, and AVPlayer falls back to downloading the
  // full mp3 before scrubbing. That's acceptable — recordings are small
  // (~600KB / <1s on LTE) and on-device scrub works. This is a Twilio
  // capability gap, NOT a bug in this proxy; do not chase a 206 here.
  // (joruva-dialer-mac-04w.)
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;

  const maxBytes = getMaxBytes();

  let twilioRes;
  try {
    twilioRes = await request(twilioUrl, { method: 'GET', headers: upstreamHeaders });
  } catch (err) {
    console.error('[recording] Twilio fetch failed:', err.message);
    return res.status(502).json({ error: 'Recording fetch failed' });
  }

  if (twilioRes.statusCode >= 400) {
    dumpBody(twilioRes.body);
    console.error(`[recording] Twilio returned ${twilioRes.statusCode}`);
    return res.status(502).json({ error: 'Recording unavailable' });
  }

  const contentLengthHeader = twilioRes.headers['content-length'];
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
  if (contentLength && contentLength > maxBytes) {
    dumpBody(twilioRes.body);
    console.error(`[recording] oversized Content-Length from Twilio: ${contentLength} > ${maxBytes}`);
    return res.status(502).json({ error: 'Recording too large' });
  }

  // Forward selected upstream headers. ETag/Last-Modified are forwarded so
  // AVPlayer can re-validate range continuity across seeks. Cache-Control
  // intentionally omitted — recordings are static for a given callId, but
  // we don't want caches treating signed URLs as long-lived (they aren't).
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const val = twilioRes.headers[h];
    if (val !== undefined) res.setHeader(h, val);
  }
  res.status(twilioRes.statusCode);

  // Counting Transform: enforces RECORDING_MAX_BYTES on chunked responses
  // (where Content-Length is absent or wrong) by destroying the pipeline
  // mid-stream. pipeline() handles teardown of all three streams + ensures
  // the upstream undici body is destroyed when the client disconnects
  // (res emits 'close' → pipeline propagates destroy to twilioRes.body).
  let bytesStreamed = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytesStreamed += chunk.length;
      if (bytesStreamed > maxBytes) {
        return cb(new Error('oversize'));
      }
      cb(null, chunk);
    },
  });

  pipeline(twilioRes.body, counter, res, (err) => {
    if (!err) return;
    if (err.message === 'oversize') {
      console.error(`[recording] oversized streaming response from Twilio: exceeded ${maxBytes}`);
    } else if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      // Premature close = client disconnect (AVPlayer seek/background/kill).
      // That's expected; not a server error worth logging.
      console.error('[recording] pipeline error:', err.message);
    }
  });
});

module.exports = router;
