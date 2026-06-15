/**
 * stt-ingest.js — in-house Media-Streams STT ingest webhook (nucleus-phone-rgja.7,
 * Stage B4). The cross-service counterpart to the Twilio RT webhook
 * (routes/transcription.js): the separate `nucleus-stt` service POSTs each finalized
 * chunk here, and a single `{event:'finalize'}` at call end. Both funnel through the
 * SAME source-agnostic lib/transcript-ingest.js, so the /api/live-analysis WS contract
 * and every downstream pipeline stay identical regardless of which STT produced the text.
 *
 * Keying: by `conferenceName` (callId == conference_name; plan review #9) — the UNIQUE
 * column that already serves both providers, so no new id is introduced. The chunk's
 * `speaker` is already typed ('agent'|'customer') by the bridge, so no mapSpeaker.
 *
 * Auth: a service-to-service bearer (STT_INGEST_SECRET), mirroring the existing apiKeyAuth
 * pattern — this is an internal endpoint, never a browser/Twilio caller.
 *
 * Dual-run gate (plan §rollout): exactly one source feeds a call. When the call's
 * use_inhouse_stt is set, the in-house path drives (ingest); otherwise Twilio RT drives
 * and this path only shadow-logs for WER/latency comparison.
 *
 * HTTP contract (the nucleus-stt HttpIngestClient retries 5xx/network, dead-letters 4xx):
 *   - 401 bad/missing bearer (client dead-letters — config error, no retry)
 *   - 503 DB lookup failed (client retries — transient)
 *   - 404 unknown conference (client dead-letters — should never happen; the row is
 *         created before the stream starts)
 *   - 204 accepted (chunk ingested/shadowed, or finalize accepted)
 */

const crypto = require('crypto');
const { Router } = require('express');
const { track } = require('../lib/inflight');
const { touch } = require('../lib/health-tracker');
const {
  ingestTranscriptChunk,
  shadowLogChunk,
  resolveCallByConference,
  finalizeByConference,
} = require('../lib/transcript-ingest');

const router = Router();

// Constant-time bearer check against STT_INGEST_SECRET. If the secret is unset the
// endpoint is hard-closed (503) rather than open — a missing secret must never mean
// "allow all" on an internal write path.
function checkBearer(req, res) {
  const secret = process.env.STT_INGEST_SECRET;
  if (!secret) {
    console.error('stt-ingest: STT_INGEST_SECRET not configured — refusing');
    res.sendStatus(503);
    return false;
  }
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!timingSafeStrEqual(token, secret)) {
    res.sendStatus(401);
    return false;
  }
  return true;
}

// Length-guarded constant-time compare (timingSafeEqual throws on length mismatch, and a
// raw === short-circuits on the first differing byte — leaking length/prefix via timing).
function timingSafeStrEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

router.post('/', async (req, res) => {
  if (!checkBearer(req, res)) return;
  touch('stt.ingest');

  const { conferenceName, event } = req.body || {};
  if (!conferenceName) return res.sendStatus(400);

  // End-of-call finalize. Ack first, summarize in the background (a slow Claude call must
  // not hold the socket). Dual-run gate: nucleus-stt POSTs a finalize for EVERY call whose
  // <Stream> is live — including Twilio-driven ones it only shadow-logs — so finalize ONLY
  // when this call is in-house-driven; otherwise the Twilio transcription-stopped path owns
  // the summary. Without this gate a Twilio-driven call would be summarized twice (once per
  // source). summarizeByKey is also idempotent on ai_summarized as defense-in-depth.
  if (event === 'finalize') {
    res.sendStatus(204);
    track(
      (async () => {
        try {
          const call = await resolveCallByConference(conferenceName);
          if (!call || !call.use_inhouse_stt) return; // Twilio drives → it owns finalize
          await finalizeByConference(conferenceName);
        } catch (err) {
          console.error('stt-ingest: finalize summary failed:', err.message);
        }
      })()
    );
    return;
  }

  const { text, speaker } = req.body;
  if (!text) return res.sendStatus(204); // nothing to ingest — ack, no retry

  let call;
  try {
    call = await resolveCallByConference(conferenceName);
  } catch (err) {
    console.error('stt-ingest: call lookup failed:', err.message);
    return res.sendStatus(503); // transient — let the client retry
  }
  if (!call) {
    console.warn(`stt-ingest: no call found for conference ${conferenceName}`);
    return res.sendStatus(404);
  }

  // Dual-run gate: drive only when this call is flagged for in-house STT; otherwise
  // Twilio RT is the driver and we just shadow-log (no write/broadcast/pipeline).
  if (call.use_inhouse_stt) {
    await ingestTranscriptChunk({ callRow: call, text, speaker, source: 'inhouse' });
  } else {
    shadowLogChunk({ source: 'inhouse', conferenceName: call.conference_name, text, speaker });
  }
  res.sendStatus(204);
});

module.exports = router;
