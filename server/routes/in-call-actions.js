// In-call rep actions (Phase F MVP, bd-9tk slice).
//
// Phase F's full bead specifies four quick-action endpoints (book-meeting,
// send-followup, crm-update, send-spec) PLUS the cue-response analytics
// hook. This file ships the cue-response hook + ENABLE_QUICK_ACTIONS env
// gate + four stub endpoints that return a clean "not implemented" error
// when called. iOS wires all five endpoints in InCallViewModel; the four
// stubs are tracked under a follow-up bead for real integration work
// (M365 calendar, HubSpot CRM, SendGrid templates). The cue-response
// hook is the load-bearing piece — without it, the suggestion cards
// fire-and-forget at the rep with no server-side analytics, so the
// coach-whisper module and the prioritizer have no closed loop.
//
// Auth + RBAC mirror cockpit.js: bearerOrApiKeyOrSession + rbac('external_caller').
// Feature flag ENABLE_QUICK_ACTIONS (env var) defaults to OFF in
// production; when off, every endpoint returns 200 { ok: false,
// reason: 'feature_disabled' } so iOS can surface a clean message
// instead of a 500.

const { Router } = require('express');
const { bearerOrApiKeyOrSession } = require('../middleware/auth');
const { rbac } = require('../middleware/rbac');

const router = Router();

function featureEnabled() {
  return process.env.ENABLE_QUICK_ACTIONS === 'true';
}

function disabledResponse(res) {
  return res.json({ ok: false, reason: 'feature_disabled' });
}

// POST /api/in-call/cue-response
//
// Rep tapped Say / Refine / Skip on a suggestion card. Server-side
// analytics log only — no DB persistence in the MVP. Future work
// (coaching scoreboard) will land a dedicated table; today the log
// line is the closed loop.
//
// Body: { callId: string, suggestionKey: string, action: 'accept' | 'refine' | 'dismiss' }
// Response: { ok: true, recordedAt: ISO8601 }
//
// Intentionally NOT gated by ENABLE_QUICK_ACTIONS — analytics flow
// should always be on so we observe rep behavior even before the
// action endpoints have real integrations. The flag exists for the
// quick-action verbs, not for the cue-response feedback loop.
router.post('/cue-response', bearerOrApiKeyOrSession, rbac('external_caller'), (req, res) => {
  const { callId, suggestionKey, action } = req.body || {};
  if (!callId || !suggestionKey || !action) {
    return res.status(400).json({ error: 'callId, suggestionKey, action required' });
  }
  if (!['accept', 'refine', 'dismiss'].includes(action)) {
    return res.status(400).json({ error: 'action must be accept | refine | dismiss' });
  }
  const recordedAt = new Date().toISOString();
  console.log(
    `[cue-response] callId=${callId} key=${suggestionKey} action=${action} ` +
    `identity=${req.user?.identity || 'unknown'} at=${recordedAt}`
  );
  return res.json({ ok: true, recordedAt });
});

// POST /api/in-call/book-meeting
// Stub: returns feature_disabled or not_implemented depending on flag.
// Real M365 calendar integration tracked in follow-up bead.
router.post('/book-meeting', bearerOrApiKeyOrSession, rbac('external_caller'), (req, res) => {
  if (!featureEnabled()) return disabledResponse(res);
  return res.json({
    ok: false,
    reason: 'not_implemented',
    message: 'Quick action wired; real M365 calendar integration pending.',
  });
});

// POST /api/in-call/send-followup
// Stub. Real SendGrid integration via lib/email-sender.js pending.
router.post('/send-followup', bearerOrApiKeyOrSession, rbac('external_caller'), (req, res) => {
  if (!featureEnabled()) return disabledResponse(res);
  return res.json({
    ok: false,
    reason: 'not_implemented',
    message: 'Quick action wired; real email send pending.',
  });
});

// POST /api/in-call/crm-update
// Stub. Real HubSpot contact update pending.
router.post('/crm-update', bearerOrApiKeyOrSession, rbac('external_caller'), (req, res) => {
  if (!featureEnabled()) return disabledResponse(res);
  return res.json({
    ok: false,
    reason: 'not_implemented',
    message: 'Quick action wired; real HubSpot update pending.',
  });
});

// POST /api/in-call/send-spec
// Stub. Real product PDF attachment + email pending.
router.post('/send-spec', bearerOrApiKeyOrSession, rbac('external_caller'), (req, res) => {
  if (!featureEnabled()) return disabledResponse(res);
  return res.json({
    ok: false,
    reason: 'not_implemented',
    message: 'Quick action wired; real spec-sheet send pending.',
  });
});

module.exports = router;
