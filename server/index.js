require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { initSchema } = require('./db');
const { errorHandler } = require('./middleware/error');
const { apiKeyAuth, sessionAuth } = require('./middleware/auth');
const { rbac } = require('./middleware/rbac');
const { startSweep } = require('./lib/stale-sweep');
const { attachWebSocket } = require('./lib/live-analysis');
const { startScheduler: startCurator } = require('./lib/equipment-curator');
const { createHmac, timingSafeEqual } = require('crypto');
const hubCatalog = require('./lib/hub-catalog-store');
const { flush: flushDebugLog } = require('./lib/debug-log');

const app = express();
const PORT = process.env.PORT || 3001;

// Render terminates TLS at its reverse proxy — tell Express to trust
// X-Forwarded-Proto so req.protocol returns 'https'. Without this,
// Twilio webhook signature validation fails (signs with https, sees http).
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? 'https://nucleus-phone.onrender.com'
    : true,
  credentials: true,
}));
app.use(express.json({
  verify: (req, _res, buf) => {
    // Capture raw body for HMAC verification on hub webhook route
    if (req.url === '/api/hub/events') req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'nucleus-phone', timestamp: new Date().toISOString() });
});

// Auth routes (no auth middleware — handles its own)
app.use('/api/auth', require('./routes/auth'));

// Routes
//
// RBAC policy (nucleus-phone-e5p):
//   • Webhooks (voice, transcription, call/recording-status, apollo-webhook)
//     authenticate via vendor signature, NOT RBAC.
//   • Route files that needed uniform policy apply router.use(auth + rbac)
//     inside themselves (signals, contacts, sim, ask, call). Route files
//     with mixed per-endpoint policy handle their own guards (history,
//     scoreboard, cockpit, token).
//   • Admin-only mounts apply rbac('admin') here.
app.use('/api/token', apiKeyAuth, rbac('external_caller'), require('./routes/token'));
app.use('/api/voice/incoming', require('./routes/incoming'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/call', require('./routes/call'));
app.use('/api/call/recording-status', require('./routes/recording'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/history', require('./routes/history'));
app.use('/api/cockpit', require('./routes/cockpit'));
app.use('/api/fireflies-sync', require('./routes/fireflies-sync'));
app.use('/api/scoreboard', require('./routes/scoreboard'));
app.use('/api/sim', require('./routes/sim'));
app.use('/api/transcription', require('./routes/transcription'));
app.use('/api/equipment', apiKeyAuth, rbac('admin'), require('./routes/equipment'));
app.use('/api/curation', apiKeyAuth, rbac('admin'), require('./routes/curation'));
app.use('/api/quote-request', sessionAuth, rbac('external_caller'), require('./routes/quote-request'));
app.use('/api/signals', require('./routes/signals'));
app.use('/api/ask', require('./routes/ask'));
app.use('/api/apollo/phone-webhook', require('./routes/apollo-webhook'));
app.use('/api/admin', apiKeyAuth, rbac('admin'), require('./routes/admin'));
app.use('/api/debug', apiKeyAuth, rbac('admin'), require('./routes/debug'));

// Hub event webhook — HMAC-authenticated, triggers catalog refresh on product.* events.
// Uses raw body capture to avoid JSON re-serialization HMAC divergence.
app.post('/api/hub/events', (req, res) => {
  const signature = req.headers['x-hub-signature'];
  const secret = process.env.HUB_SPOKE_SECRET;
  if (!signature || !secret || !req.rawBody) return res.status(401).json({ error: 'Not authorized' });

  const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.json({ accepted: true });

  // Async: refresh catalog on product events
  const eventType = req.body.event_type || '';
  if (eventType.startsWith('product.') || eventType.startsWith('catalog.')) {
    hubCatalog.refreshNow().catch(err => console.error('[hub-events] Catalog refresh failed:', err.message));
  }
});

// Serve React build in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.use(errorHandler);

let httpServer;

async function start() {
  await initSchema();
  startSweep();
  startCurator();
  hubCatalog.startRefreshLoop();
  httpServer = app.listen(PORT, () => {
    console.log(`nucleus-phone listening on :${PORT}`);
  });
  attachWebSocket(httpServer);
}

if (require.main === module) {
  const { drain } = require('./lib/inflight');

  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });

  // Graceful shutdown — Render gives 10s after SIGTERM
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    if (httpServer) httpServer.close(); // stop accepting new connections
    // Flush debug event buffer before drain consumes the time budget
    await flushDebugLog();
    await drain(8000); // 8s budget, 2s margin for cleanup
    process.exit(0);
  });
}

module.exports = { app };
