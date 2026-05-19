const twilio = require('twilio');

const DEFAULT_BASE_URL = 'https://nucleus-phone.onrender.com';

// Lazy-eval wrapper around twilio.webhook(). Reads NODE_ENV + APP_URL on
// every request rather than freezing them at module-load time. The earlier
// per-route pattern — `const twilioWebhook = twilio.webhook({ validate:
// process.env.NODE_ENV === 'production', url: ... })` evaluated at file
// require — froze whatever env was present when the module first loaded,
// making behavior untestable across NODE_ENV values without
// jest.resetModules() gymnastics. Surfaced by joruva-dialer-mac-d74:
// developer shells exporting NODE_ENV=production caused jest to inherit
// it, and signature validation was permanently ON for tests.
//
// Per-request construction is fine here: webhook routes are low-volume
// (a few req/sec at peak) and twilio.webhook() just builds a closure.
function makeTwilioWebhook(path) {
  return function hook(req, res, next) {
    const baseUrl = process.env.APP_URL || DEFAULT_BASE_URL;
    const validate = process.env.NODE_ENV === 'production';
    // Twilio computes the signature over the FULL request URL including
    // query string. Pre-2026-05-19 we passed `url: ${baseUrl}${path}` which
    // dropped the query — twilio.webhook() honors `options.url` AS-IS
    // (see node_modules/twilio/lib/webhooks/webhooks.js validateIncomingRequest)
    // so signatures mismatched on every action-URL callback (dial-complete,
    // rep-status, voicemail, voicemail-complete) and Twilio got a 403.
    // The bug was silently masked on PSTN inbound because Twilio falls back
    // to the inline TwiML safety net after a 403 from the action URL.
    // Surfaced when iOS dial timed out and Twilio retried the number-level
    // fallback URL → caller heard the "technical difficulties" message.
    //
    // req.originalUrl includes both pathname AND query string as received
    // from the proxy (Render terminates TLS and forwards unchanged), so
    // `${baseUrl}${req.originalUrl}` is the exact URL Twilio signed.
    // The `path` argument is preserved as call-site documentation.
    return twilio.webhook({ validate, url: `${baseUrl}${req.originalUrl}` })(req, res, next);
  };
}

module.exports = { makeTwilioWebhook };
