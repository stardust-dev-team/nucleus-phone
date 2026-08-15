/**
 * live-analysis.js — WebSocket server for real-time equipment analysis.
 *
 * Attaches to the Express HTTP server and handles upgrade requests at
 * /api/live-analysis. Browser clients subscribe to a callId and receive
 * equipment detections, sizing updates, and transcript chunks in real time.
 *
 * Auth: manually parses Authorization: Bearer <jwt> first (native iOS
 * dialer — URLSessionWebSocketTask doesn't carry cookies), then falls
 * back to the nucleus_session cookie (browsers). Express middleware
 * doesn't run for WebSocket upgrades, so we do this by hand.
 *
 * jsec-z4ff — WHAT THIS CHANNEL CARRIES, and why it is authorized like audio:
 *
 * The subscription key IS the conference name (routes/transcription.js sets
 * `callId = call.conference_name` before broadcasting), and what flows over it
 * is the live transcript, sentiment, equipment detections and coach cues of a
 * real customer call. Until this change the upgrade verified a JWT signature
 * and NOTHING else, and `subscribe` did no ownership check at all — so anyone
 * holding any valid token could name any conference and read that rep's call.
 *
 * That is the exposure jsec-r0k6 closed on the audio paths, reached through a
 * different door: a text transcript with no authorization is not a lesser harm
 * than a second pair of ears. So this applies the SAME rule — admin, or the rep
 * the conference belongs to — rather than inventing a second, weaker one.
 *
 * Two things a signature check alone could not do, and now does:
 *   (1) A DEACTIVATED user kept access for the remaining life of a 30-day
 *       token, because nothing loaded the row. loadUserById returns null for
 *       is_active=false, so revocation takes effect here too.
 *   (2) Role and identity were unknown at this layer. They are exactly what the
 *       subscribe check needs.
 */

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const jwt = require('jsonwebtoken');
const { logEvent } = require('./debug-log');
const { AQ_RANK } = require('./aq-constants');
const { loadUserById } = require('../middleware/auth');
const { hasMinRole } = require('../middleware/rbac');
const { getConference } = require('./conference');

// callId -> Set<ws>
const subscriptions = new Map();

// callId -> Set<'manufacturer:model'> — avoids re-broadcasting same equipment
const seen = new Map();

// callId -> Array<equipment> — accumulated equipment for sizing recalculation.
// Ephemeral: lost on restart, but sizing rebuilds from subsequent detections.
const callEquipment = new Map();

// callId -> string — highest-priority air quality class detected from conversation
// context (e.g. AS9100/aerospace → ISO_8573_1). Separate from equipment-derived
// air quality because CNC machines default to 'general' even in aerospace shops.
const callAirQuality = new Map();

/**
 * Resolve a verified JWT payload to a live user row, or null.
 *
 * Mirrors sessionAuth (middleware/auth.js): new tokens carry only `userId`;
 * pre-e5p tokens carried identity/role/email inline and are still in the wild
 * until those cookies expire. loadUserById returns null for a deleted or
 * deactivated account, which is what makes revocation reach this socket.
 *
 * The legacy branch deliberately re-resolves by identity through the registry
 * rather than trusting the role baked into the old token — otherwise a token
 * minted while someone was an admin would keep admin powers here forever.
 */
async function resolveUser(payload) {
  if (payload?.userId) return loadUserById(payload.userId);

  if (payload?.identity && payload?.role) {
    // Re-read the current row by identity; ignore the token's own role claim.
    const { pool } = require('../db');
    const { rows } = await pool.query(
      `SELECT id, email, identity, role, display_name, is_active
         FROM nucleus_phone_users
        WHERE LOWER(identity) = LOWER($1)`,
      [payload.identity]
    );
    if (!rows.length || !rows[0].is_active) return null;
    const row = rows[0];
    return {
      id: row.id, email: row.email, identity: row.identity,
      role: row.role, displayName: row.display_name,
    };
  }
  return null;
}

/**
 * Why `user` may NOT subscribe to `callId`, or null if they may.
 *
 * Returns a REASON rather than a boolean so the refusal is loggable and the
 * client can be told something honest. Every failure path returns a string —
 * the default is refusal, so a future branch that forgets to return denies
 * rather than admits.
 *
 * The rule is deliberately identical to requireConferenceOwner in
 * routes/call.js (jsec-vr1s / jsec-r0k6): an admin sees anything; everyone else
 * sees only a conference they own. It is restated here rather than imported
 * because that helper writes an HTTP response, which is meaningless on a
 * socket — but if the two ever disagree about what "owner" means, THIS is the
 * copy to fix, and conf.startedBy is the only owner field the store writes.
 */
function subscribeDenialReason(user, callId) {
  if (!user) return 'no authenticated user on the socket';
  if (typeof callId !== 'string' || !callId) return 'malformed callId';

  const conf = getConference(callId);
  if (!conf) {
    // Fail closed on an unknown conference. The in-memory store is the only
    // record of who owns what, so "not found" means "cannot be authorized" —
    // never "no owner, therefore anyone". This also covers the post-restart
    // case, where the transcript stream is dead anyway.
    return 'unknown or ended conference';
  }

  if (hasMinRole(user.role, 'admin')) return null;

  const owner = typeof conf.startedBy === 'string' ? conf.startedBy.toLowerCase() : '';
  const me = (user.identity || '').toLowerCase();
  // Lowercase both sides for the same reason routes/call.js does (001z): the
  // registry is canonically lowercase but a display-cased value on either side
  // would otherwise turn into a permanent, silent refusal.
  if (owner && me && owner === me) return null;

  return 'not your call';
}

/** Send JSON if the socket is still open. Never throws into the message loop. */
function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.debug('live-analysis: send failed:', err.message);
  }
}

function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== '/api/live-analysis') {
      socket.destroy();
      return;
    }

    // Mirrors `bearerOrSession` in server/middleware/auth.js: presence of the
    // Authorization header is the discriminator (not its validity), so a
    // malformed bearer doesn't silently fall back to the cookie path.
    const token = req.headers.authorization
      ? parseBearer(req.headers.authorization)
      : parseCookie(req.headers.cookie, 'nucleus_session');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.warn('live-analysis: JWT verify failed:', err.message);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // jsec-z4ff: resolve the actual user. A verified signature says the token
    // was minted by us; it does not say the account still exists, is still
    // active, or what it may see. Mirrors sessionAuth's payload handling,
    // legacy shape included, so one auth model governs HTTP and WS alike —
    // a divergence here is how a socket quietly outlives a revocation.
    resolveUser(payload)
      .then((user) => {
        if (!user) {
          console.warn('live-analysis: token valid but user is unknown or deactivated');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        console.log(`live-analysis: WebSocket upgrade accepted for ${user.identity} (${user.role})`);
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws._user = user;
          wss.emit('connection', ws, req);
        });
      })
      .catch((err) => {
        // Fail CLOSED. A DB blip must not become an open door.
        console.error('live-analysis: user lookup failed:', err.message);
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
  });

  wss.on('connection', (ws) => {
    ws._callId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'subscribe' && msg.callId) {
        // jsec-z4ff: the subscription key is a conference name, so subscribing
        // is exactly "let me listen to this call" — authorize it as such.
        const denial = subscribeDenialReason(ws._user, msg.callId);
        if (denial) {
          console.warn(`live-analysis: subscribe REFUSED for ${ws._user?.identity || '(unknown)'} on ${msg.callId} — ${denial}`);
          logEvent('error', 'live-analysis', `subscribe REFUSED: ${denial}`, {
            level: 'error',
            caller: ws._user?.identity,
            detail: { callId: msg.callId, reason: denial },
          });
          // Tell the client explicitly. Silently not-subscribing would render
          // as a cockpit that simply never populates — indistinguishable from
          // a quiet call or a broken pipeline, and impossible to support.
          safeSend(ws, { type: 'subscribe_denied', data: { callId: msg.callId, reason: denial } });
          return;
        }

        // Unsubscribe from previous if switching calls
        if (ws._callId) unsubClient(ws._callId, ws);
        ws._callId = msg.callId;
        if (!subscriptions.has(msg.callId)) subscriptions.set(msg.callId, new Set());
        subscriptions.get(msg.callId).add(ws);
        console.log(`live-analysis: ${ws._user.identity} subscribed to ${msg.callId} (${subscriptions.get(msg.callId).size} listeners)`);
        logEvent('state_change', 'live-analysis', `subscribe: ${msg.callId}`, { detail: { callId: msg.callId, caller: ws._user.identity, listeners: subscriptions.get(msg.callId).size } });
      }

      if (msg.type === 'unsubscribe') {
        if (ws._callId) unsubClient(ws._callId, ws);
        ws._callId = null;
      }
    });

    ws.on('close', () => {
      if (ws._callId) {
        logEvent('state_change', 'live-analysis', `disconnect: ${ws._callId}`, { detail: { callId: ws._callId } });
        unsubClient(ws._callId, ws);
      }
    });
  });
}

function unsubClient(callId, ws) {
  const clients = subscriptions.get(callId);
  if (!clients) return;
  clients.delete(ws);
  if (clients.size === 0) {
    subscriptions.delete(callId);
    seen.delete(callId);
    callEquipment.delete(callId);
    callAirQuality.delete(callId);
  }
}

/**
 * Broadcast a message to all clients subscribed to callId.
 * For equipment_detected messages, deduplicates by manufacturer:model.
 */
function broadcast(callId, message) {
  const clients = subscriptions.get(callId);
  if (!clients || clients.size === 0) {
    if (message.type === 'equipment_detected') {
      console.warn(`live-analysis: equipment detected for ${callId} but no subscribers`);
    }
    return;
  }

  // Dedup equipment detections (skip dedup for null manufacturer to avoid
  // collisions — e.g. "we run Haas" and "we also have Mazak" both with
  // model: null would otherwise collide as "null:null")
  if (message.type === 'equipment_detected' && message.data.manufacturer) {
    const key = `${message.data.manufacturer}:${message.data.model}`;
    if (!seen.has(callId)) seen.set(callId, new Set());
    const seenSet = seen.get(callId);
    if (seenSet.has(key)) return;
    seenSet.add(key);
  }

  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/**
 * Clean up all state for a completed call.
 * Closes any remaining WebSocket connections so browsers know the call ended.
 *
 * Note: ws.close() triggers async 'close' events which call unsubClient().
 * That's harmless — unsubClient guards against already-deleted map entries,
 * and we delete the maps synchronously below before those callbacks fire.
 */
function cleanupCall(callId) {
  const clients = subscriptions.get(callId);
  if (clients) {
    for (const ws of clients) ws.close(1000, 'call ended');
  }
  subscriptions.delete(callId);
  seen.delete(callId);
  callEquipment.delete(callId);
  callAirQuality.delete(callId);
}

/**
 * Get (or create) the accumulated equipment array for a call.
 */
function getCallEquipment(callId) {
  if (!callEquipment.has(callId)) callEquipment.set(callId, []);
  return callEquipment.get(callId);
}

/**
 * Clear accumulated equipment and broadcast dedup state for a call.
 * Used by the verbal reset trigger — rep says a phrase, system starts fresh.
 * Preserves the array reference (splice, not replace) so in-flight code
 * holding the old reference sees the empty array.
 */
function resetCallEquipment(callId) {
  const arr = callEquipment.get(callId);
  if (arr) arr.splice(0);
  seen.delete(callId);
}

/**
 * Get the highest-priority air quality class detected from conversation context.
 */
function getCallAirQuality(callId) {
  return callAirQuality.get(callId) || null;
}

/**
 * Set air quality class from conversation context, keeping the highest priority.
 * ISO_8573_1 > paint_grade > general/null.
 */
function setCallAirQuality(callId, aqClass) {
  const current = callAirQuality.get(callId);
  if ((AQ_RANK[aqClass] || 0) > (AQ_RANK[current] || 0)) {
    callAirQuality.set(callId, aqClass);
    return true;   // escalated
  }
  return false;     // no change
}

/**
 * Parse the JWT out of an `Authorization: Bearer <jwt>` header.
 * Returns null if the header is missing or doesn't start with "Bearer ".
 */
function parseBearer(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
}

/**
 * Parse a specific cookie value from the raw Cookie header string.
 * Returns null if not found.
 */
function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split('; ')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.substring(0, eq) === name) {
      return decodeURIComponent(pair.substring(eq + 1));
    }
  }
  return null;
}

/**
 * Return active WebSocket connection stats for the debug endpoint.
 */
function getConnectionStats() {
  const websockets = [];
  for (const [callId, clients] of subscriptions) {
    if (clients.size > 0) websockets.push({ callId, listenerCount: clients.size });
  }
  return { websockets, total: websockets.length };
}

module.exports = { attachWebSocket, broadcast, cleanupCall, getCallEquipment, resetCallEquipment, getCallAirQuality, setCallAirQuality, getConnectionStats };
