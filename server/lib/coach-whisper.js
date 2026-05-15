/**
 * coach-whisper.js — Advisory-tier pacing coach for the Live Assist cockpit.
 *
 * Runs a debounced Haiku pass that emits short pacing nudges
 * ("slow down on price," "ask about cycle time") when the conversation
 * crosses a phase boundary or the customer's sentiment shifts. The cue
 * surfaces on iOS as a passive corner panel (`CoachWhisperCard`) — never
 * a hero card, no haptic, no peek-elevate.
 *
 * Architectural notes (idempotent-frolicking-starlight.md § Phase E):
 * - **Own state map**, keyed by callId. Never reaches into
 *   conversation-pipeline's `callState`.
 * - **Own inFlight flag**. MUST NOT share `state.analysisInFlight` with
 *   `runAnalysis` — sharing would mean a long whisper call blocks
 *   conversation analysis (or vice versa), defeating the parallel-stream
 *   intent.
 * - **Hook after runAnalysis resolves**. The whisper logic reads
 *   `state.lastPhase` and `state.sentimentHistory`, both updated by
 *   `runAnalysis`. Calling before would read stale state on phase-change
 *   ticks.
 * - **Fire-and-forget from the caller**. Internal early-returns and
 *   inFlight guard the work; the caller never awaits and never blocks.
 */

const { broadcast } = require('./live-analysis');
const { logEvent } = require('./debug-log');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const FETCH_TIMEOUT_MS = 5000;
/// Minimum cool-down between successive whispers on the same call. 8s
/// matches the conversation-pipeline batch cadence so we never emit
/// faster than the upstream phase/sentiment ticks could change.
const MIN_COOLDOWN_MS = 8000;
/// Minimum transcript window length before we even try — short windows
/// produce platitudes ("good opener"), not pacing signal.
const MIN_WINDOW_CHARS = 50;
const MAX_TOKENS = 96;
/// Server only emits `source: 'ai'` today. `'human'` is reserved for the
/// future human-coach inject endpoint (filed as a follow-up bead per
/// plan § 937, not Day-1). iOS already decodes both via the
/// `WhisperSource` enum + `.unknown` forward-compat fallback.
const AUTHOR_NAME = 'Aunshin Coach';

// Pacing-coach system prompt. Deliberately narrower than the
// conversation-pipeline analyst — this isn't a sales advisor, it's a
// timing/cadence coach. Single sentence out, no chrome.
const SYSTEM_PROMPT = `You are a pacing coach for Joruva Industrial sales reps mid-call. Joruva sells compressed air systems (rotary screw compressors, dryers, filters) to manufacturing shops.

The rep is on a live call. You receive a rolling transcript window plus the current conversation phase and the customer's sentiment. Your job: emit ONE short pacing nudge (≤ 18 words) that helps the rep adjust how they're carrying the conversation, NOT what to say.

Pacing nudges are about cadence, energy, and focus — not content:
- "Slow down on the price reveal — they're still mapping their problem."
- "Customer's warming up. Stay specific, don't pitch yet."
- "You're talking over them. Let them finish the thought."
- "Sentiment slipping. Acknowledge before you advance."
- "Phase shifted to pricing — drop the discovery questions now."

Hard rules:
- Return ONLY a JSON object: {"text":"..."} — nothing else.
- Single sentence, ≤ 18 words.
- No emojis, no quotes, no markdown.
- If no clear pacing issue at this moment, return {"text":""} (empty string suppresses emit).`;

// Cached system payload — same prompt-caching pattern as
// conversation-pipeline.js:127. The cache-control marker tells Anthropic
// to serve subsequent calls from the cached prefix at lower cost.
const SYSTEM_PAYLOAD = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

// ── Per-call state ──────────────────────────────────────────────────────
//
// Separate from conversation-pipeline's callState by design (plan § 285).
// Each call's whisper state tracks:
//   - lastEmitAt: epoch ms of the previous emit; gates the cooldown.
//   - lastEmittedPhase / lastEmittedSentiment: what we already nudged on.
//     A nudge re-fires only when at least one of these has shifted.
//   - inFlight: a single whisper call is in flight; suppress new starts
//     until it resolves. Independent of state.analysisInFlight.

const coachState = new Map();

function getCoachState(callId) {
  if (!coachState.has(callId)) {
    coachState.set(callId, {
      lastEmitAt: 0,
      lastEmittedPhase: null,
      lastEmittedSentiment: null,
      inFlight: false,
    });
  }
  return coachState.get(callId);
}

// Pure decision function — exposed for tests. Returns true iff a whisper
// SHOULD fire given the current state. Time injected so tests don't
// sleep.
function shouldEmit({ now, ws, phaseNow, sentimentNow }) {
  if (ws.inFlight) return false;
  if (now - ws.lastEmitAt < MIN_COOLDOWN_MS) return false;
  const phaseShift = phaseNow && phaseNow !== ws.lastEmittedPhase;
  const sentShift = sentimentNow && sentimentNow !== ws.lastEmittedSentiment;
  return Boolean(phaseShift || sentShift);
}

// ── Haiku call ──────────────────────────────────────────────────────────

async function callHaiku({ callId, window, phase, sentiment }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const userMessage =
    `Current phase: ${phase || 'unknown'}\n` +
    `Customer sentiment: ${sentiment || 'unknown'}\n\n` +
    `Transcript window:\n${window}`;

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PAYLOAD,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logEvent('error', 'coach-whisper', `Haiku API ${res.status}: ${body.substring(0, 200)}`, { detail: { callId } });
      return null;
    }

    const data = await res.json();
    const raw = (data.content?.[0]?.text || '').trim();
    if (!raw) return null;

    // Strip optional fences (Haiku occasionally adds them despite the
    // hard-rule in the prompt). Same defensive pattern as
    // conversation-pipeline.js:248-251.
    let cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '').trim();
    if (!cleaned.startsWith('{')) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);
    }

    try {
      const parsed = JSON.parse(cleaned);
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      return text || null;
    } catch (parseErr) {
      logEvent('error', 'coach-whisper', `JSON parse failed: ${parseErr.message}`, { detail: { callId } });
      return null;
    }
  } catch (err) {
    clearTimeout(timer);
    logEvent('error', 'coach-whisper', `Haiku call failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`, { detail: { callId } });
    return null;
  }
}

// ── Public hook ─────────────────────────────────────────────────────────

/**
 * Hook called by `processConversationChunk` AFTER `runAnalysis` resolves.
 * Fire-and-forget — the caller does not await. Internal guards prevent
 * pile-ups and stale-state work.
 *
 * `state` is the conversation-pipeline call state (NOT mutated here —
 * read-only). `now` is injectable for tests.
 */
async function maybeEmitCoachWhisper(callId, state, { now = Date.now() } = {}) {
  if (!state || state.aborted) return;

  const ws = getCoachState(callId);
  const phaseNow = state.lastPhase || null;
  const lastSent = state.sentimentHistory && state.sentimentHistory.length > 0
    ? state.sentimentHistory[state.sentimentHistory.length - 1]
    : null;
  const sentimentNow = lastSent ? lastSent.customer : null;

  if (!shouldEmit({ now, ws, phaseNow, sentimentNow })) return;

  // Build the transcript window the same way conversation-pipeline does
  // — read from state.history without mutating (the pipeline owns the
  // trim-by-age step).
  const window = (state.history || []).map(h => h.text).join(' ');
  if (!window || window.length < MIN_WINDOW_CHARS) return;

  ws.inFlight = true;
  try {
    const text = await callHaiku({ callId, window, phase: phaseNow, sentiment: sentimentNow });

    // Call may have ended mid-await — same gate as runAnalysis uses.
    if (state.aborted) {
      logEvent('info', 'coach-whisper', `whisper aborted mid-Haiku | callId=${callId}`);
      return;
    }
    if (!text) return;

    // Use the injected `now` for state bookkeeping so test-supplied
    // clocks compose cleanly. Real callers pass Date.now() as the
    // default; tests pass a monotonically-increasing virtual clock.
    ws.lastEmitAt = now;
    ws.lastEmittedPhase = phaseNow;
    ws.lastEmittedSentiment = sentimentNow;

    broadcast(callId, {
      type: 'coach_whisper',
      data: {
        source: 'ai',
        author_name: AUTHOR_NAME,
        text,
        ts: new Date(now).toISOString(),
      },
    });
    logEvent('info', 'coach-whisper', `whisper served | callId=${callId} phase=${phaseNow || '-'} sentiment=${sentimentNow || '-'}`);
  } finally {
    ws.inFlight = false;
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanupCoachWhisperState(callId) {
  coachState.delete(callId);
}

module.exports = {
  maybeEmitCoachWhisper,
  cleanupCoachWhisperState,
  // Exposed for testing
  _coachState: coachState,
  _shouldEmit: shouldEmit,
  _SYSTEM_PROMPT: SYSTEM_PROMPT,
  _SYSTEM_PAYLOAD: SYSTEM_PAYLOAD,
  _MIN_COOLDOWN_MS: MIN_COOLDOWN_MS,
  _MIN_WINDOW_CHARS: MIN_WINDOW_CHARS,
};
