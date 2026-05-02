// Pin NODE_ENV=test before any module loads. Some routes evaluate
// process.env.NODE_ENV at require time to gate behavior (e.g. call.js
// turns Twilio webhook signature validation on in production). If a
// developer's shell has NODE_ENV=production exported, jest inherits it
// and tests fail with 400s on webhook routes. Jest defaults to 'test'
// only when NODE_ENV is unset — this setup file makes the default
// authoritative regardless of the host environment.
process.env.NODE_ENV = 'test';
