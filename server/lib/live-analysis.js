/**
 * live-analysis.js — WebSocket server for real-time equipment analysis.
 *
 * Attaches to the Express HTTP server and handles upgrade requests at
 * /api/live-analysis. Browser clients subscribe to a callId and receive
 * equipment detections, sizing updates, and transcript chunks in real time.
 *
 * Auth: manually parses the Cookie header on upgrade (Express middleware
 * doesn't run for WebSocket upgrades) and verifies the JWT.
 */

const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const jwt = require('jsonwebtoken');
const { logEvent } = require('./debug-log');
const { AQ_RANK } = require('./aq-constants');

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

function attachWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    if (pathname !== '/api/live-analysis') {
      socket.destroy();
      return;
    }

    const token = parseCookie(req.headers.cookie, 'nucleus_session');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.warn('live-analysis: JWT verify failed:', err.message);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log('live-analysis: WebSocket upgrade accepted');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
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
        // Unsubscribe from previous if switching calls
        if (ws._callId) unsubClient(ws._callId, ws);
        ws._callId = msg.callId;
        if (!subscriptions.has(msg.callId)) subscriptions.set(msg.callId, new Set());
        subscriptions.get(msg.callId).add(ws);
        console.log(`live-analysis: client subscribed to ${msg.callId} (${subscriptions.get(msg.callId).size} listeners)`);
        logEvent('state_change', 'live-analysis', `subscribe: ${msg.callId}`, { detail: { callId: msg.callId, listeners: subscriptions.get(msg.callId).size } });
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

module.exports = { attachWebSocket, broadcast, cleanupCall, getCallEquipment, getCallAirQuality, setCallAirQuality, getConnectionStats };
