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
    return twilio.webhook({ validate, url: `${baseUrl}${path}` })(req, res, next);
  };
}

module.exports = { makeTwilioWebhook };
