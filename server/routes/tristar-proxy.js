/**
 * tristar-proxy.js — bead nucleus-phone-stet (P1).
 *
 * Server-side proxy that injects TRISTAR_API_KEY so the cockpit never holds
 * it. In TriStar mode the cockpit calls SAME-ORIGIN /api/tristar/<path>; this
 * router forwards to TRISTAR_API_BASE_URL with X-API-Key added and returns the
 * upstream response verbatim. The key lives only in nucleus-phone's server env
 * — it is never sent to a browser (see server/routes/auth.js buildTristarConfig,
 * which now returns only a boolean `configured` flag).
 *
 * Mounted in server/index.js behind sessionAuth + tristarGate, so only an
 * authenticated principal on TRISTAR_ALLOWED_IDENTITIES can reach it — the same
 * allowlist that gated v1's /me key delivery, now enforced server-side.
 *
 * CLOSED proxy: only the exact ROUTED subpaths are forwarded; anything else
 * 404s. This can never become an open relay to TriStar's API. The subpath list
 * mirrors the client mode-router ROUTED_PATHS — a drift test pins the two.
 *
 * No-local-writes contract: a routed path must NEVER fall through to
 * nucleus-phone's local handlers. A misconfigured/unreachable upstream returns
 * 503/502 here rather than silently writing to nucleus_phone_calls.
 */
const express = require('express');

const router = express.Router();

// Mirror of client/src/lib/mode-router.js ROUTED_PATHS. Kept as an independent
// server-side source of truth (the client list is ESM; duplicating four anchored
// patterns is cheaper and safer than cross-importing ESM into CJS). The drift
// test in __tests__/tristar-proxy.test.js asserts this set matches the contract.
const ROUTED_SUBPATHS = [
  /^\/queue$/,
  /^\/call\/initiate$/,
  /^\/call\/[^/]+\/disposition$/,
  /^\/token$/,
];

function isRoutedSubpath(p) {
  return ROUTED_SUBPATHS.some((re) => re.test(p));
}

// router.use handles ALL methods/subpaths; req.path is the remainder after the
// /api/tristar mount point. Using .use (not .all('/*')) sidesteps Express
// path-pattern quirks and keeps the closed-proxy check explicit.
router.use(async (req, res) => {
  const subpath = req.path;

  // Reject percent-encoding and dot-segments BEFORE the allowlist test. Every
  // routed path is literal ASCII, so any %xx (esp. %2f / %2F encoded slash,
  // %00 null) or '..' is an attempt to smuggle an extra path segment through
  // the [^/]+ :id slot — the upstream would decode %2f to '/' and could route
  // it elsewhere within the /call/.../disposition shape. Linus review 2026-06-21.
  if (/%|\.\./.test(subpath)) {
    return res.status(400).json({ error: 'Invalid TriStar path' });
  }

  if (!isRoutedSubpath(subpath)) {
    return res.status(404).json({ error: 'Not a routed TriStar path' });
  }

  const base = (process.env.TRISTAR_API_BASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.TRISTAR_API_KEY || '').trim();
  if (!base || !key) {
    // Server misconfig (env missing or rotated/cleared mid-session). The cockpit
    // only enters TriStar mode when /me reported configured:true, so reaching
    // here means the env changed under a live session. 503, never a local
    // fallback — that's the no-local-writes contract at the proxy boundary.
    return res.status(503).json({ error: 'TriStar proxy not configured' });
  }

  // Preserve any query string from the original request (e.g. /queue?tier=hot,
  // /token?identity=...). req.path strips it; req.originalUrl keeps it.
  const qIdx = req.originalUrl.indexOf('?');
  const qs = qIdx === -1 ? '' : req.originalUrl.slice(qIdx);
  const upstreamUrl = `${base}${subpath}${qs}`;

  // Inject the key. Forward Content-Type + re-serialized body for non-GET/HEAD
  // (express.json already parsed req.body upstream). Do NOT forward cookies
  // (cross-origin; auth IS the injected key) or the caller's X-API-Key /
  // X-Cockpit-Mode headers — the proxy is the sole authority on what TriStar
  // sees.
  const headers = { 'X-API-Key': key, Accept: 'application/json' };
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body ?? {});
  }

  // fetch AND body read are both inside the try: Express 4 does not catch
  // async-middleware rejections, so an unguarded reject would hang the request.
  try {
    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    // Pass the upstream response through verbatim — status, content-type, body.
    // The cockpit's api.js maps 401/403 to ApiAuthError + the auth-failed
    // banner; a clean 2xx fires the tristar-ok banner-clear. We stay out of
    // that policy.
    const text = await upstream.text();
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    return res.send(text);
  } catch (err) {
    console.error('[tristar-proxy] upstream request failed:', err.message);
    return res.status(502).json({ error: 'TriStar upstream unreachable' });
  }
});

module.exports = router;
