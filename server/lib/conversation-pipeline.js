/**
 * conversation-pipeline.js — Real-time conversation analysis for the Navigator.
 *
 * Accumulates transcript chunks, sends rolling ~60s windows to Haiku for
 * phase detection, sentiment analysis, and response suggestions. Broadcasts
 * results via the existing WebSocket infrastructure in live-analysis.js.
 *
 * Tier 3 only (batched, ~8s). Tiers 0-2 are layered on top in a separate issue.
 */

const { broadcast } = require('./live-analysis');
const { logEvent } = require('./debug-log');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const FETCH_TIMEOUT = 5000;
const BUFFER_INTERVAL_MS = 8000;   // 8s batch cycle
const MIN_BUFFER_CHUNKS = 3;       // OR 3 chunks, whichever comes first
const HISTORY_WINDOW_MS = 60000;   // rolling ~60s transcript window
const MAX_SENTIMENT_HISTORY = 20;  // cap at 20 entries (~2.7 min at 8s cycle)
const DEGRADED_THRESHOLD = 3;      // consecutive failures before degraded mode

// Tier 2 question detection. Two branches only:
//   1. literal "?" anywhere (reliable when ASR emits punctuation)
//   2. wh-word (who/what/when/where/why/how) at chunk start or after
//      sentence-terminal punctuation, AND NOT immediately followed by a
//      subject pronoun (we/i/he/she/they) — that pattern signals a
//      wh-cleft/relative ("What we do is…", "Why I called was…"), not a
//      question.
// Aux verbs (is/are/do/does/can/will/…) are deliberately excluded — they
// false-positive on statements like "Is what I said" or "Do that tomorrow"
// and every false-positive costs a Haiku call. Wh-words carry the signal
// with much lower noise.
//
// Known residual leaks (all accepted — see known-leak test block):
//   1. "you"-fronted clefts ("What you need is…") match; "you" isn't in
//      the pronoun exclusion list because "What you doing?" is a real
//      question in spoken ASR.
//   2. Contraction clefts ("What's needed is…") match; the apostrophe
//      breaks the \s+ in the lookahead so the exclusion doesn't fire.
//   3. "How come …" phrases match; treated as questions (they usually are).
//
// Also: if production ASR strips both "?" and sentence punctuation, only
// chunk-start wh-words match. Measure hit rate in production before
// tightening further.
const QUESTION_REGEX = /\?|(?:^|[.!?]\s+)(who|what|when|where|why|how)\b(?!\s+(?:we|i|he|she|they)\b)/i;

// Suggestion source tags (single source of truth for hit-rate log parsing).
// Names describe the *trigger*, not the backend model — so swapping Haiku
// for another LLM later doesn't make the wire contract lie.
const DEFAULT_SOURCE_TAG = 'tier3_batch';        // 8s buffered cycle
const BYPASS_SOURCE_TAG = 'tier2_question';      // question-signal immediate fire
const EXIT_ASSIST_SOURCE_TAG = 'exit_assist';    // hostile/tanking off-ramp
// Client-side Tier 0 matches stamp source='prediction' in the hook. Kept
// here as a grep target so renames can't miss the client side.
// const TIER0_SOURCE_TAG = 'prediction';  // client-only, see useLiveAnalysis.js

// Hit-rate log format contract (downstream parsers depend on this):
//   "suggestion served | callId=<id> source=<tag> trigger=<trigger>"
//   "suggestion suppressed | callId=<id> reason=<reason> trigger=<trigger>"
//   "analysis cycle | callId=<id> source=<tag> latency=<ms> phase=<phase|->"
// Keep key=value pipe-delimited. "-" is the sentinel for missing values.

// ── System prompt (same as validated in scripts/test-conversation-latency.js) ──

// SYNC CHECK: copied from server/lib/claude.js PRODUCT_CATALOG to avoid coupling.
const PRODUCT_CATALOG = `Joruva Industrial products (confirmed pricing):
Compressors: JRS-7.5E 7.5HP 28CFM $7,495 | JRS-10E 10HP 38CFM $9,495 | JRS-30 30HP 125CFM $19,500 (direct)
Dryers (refrigerated): JRD-30 $2,195 | JRD-40 $2,495 | JRD-60 $2,895 | JRD-80 $3,195 | JRD-100 $3,595
Dryers (desiccant, -60°F, molecular sieve, wall-mount): JDD-40 40CFM $7,495 | JDD-80 80CFM $11,895
Filters: JPF-70 particulate 1µm $399 | JPF-130 $499 | JCF-70 coalescing 0.01µm $349 | JCF-130 $449
OWS (oil-water separator): OWS75 $234 | OWS150 $1,092
Larger systems (30HP+): direct sale, custom quote required.
For AS9100/aerospace: recommend desiccant dryer + coalescing filter. General mfg: refrigerated dryer.`;

const OBJECTION_PAIRS = `Common objections and rebuttals:
- "Too expensive" / "We're cheaper than the downtime you're paying for now. JRS-10E pays for itself in 18 months vs ongoing recip maintenance."
- "We already have a vendor" / "Totally get it. Most of our customers had a vendor too. We're not asking you to switch tomorrow — just worth a comparison on the next replacement cycle."
- "Never heard of Joruva" / "Fair point. We're newer to the market, which means better pricing and actual phone support — not a 1-800 number."
- "Just looking" / "No pressure at all. Let me send you specs so when the time comes, you've got everything in front of you."
- "Need to talk to my partner/boss" / "Of course. Want me to put together a one-pager you can share? Makes the conversation easier."`;

const SYSTEM_PROMPT = `You are a real-time conversation analyst for Joruva Industrial sales calls. Joruva sells compressed air systems (rotary screw compressors, dryers, filters, oil-water separators) to manufacturing shops, job shops, and industrial facilities. The caller is a Joruva sales rep. The prospect is typically a shop owner, plant manager, or maintenance lead.

You analyze transcript chunks and return a JSON object with exactly these fields:

PHASE — the current conversation phase. Must be one of: greeting, discovery, qualification, equipment_discussion, objection_handling, pricing, closing, small_talk.
Phase definitions:
- greeting: Initial pleasantries, introductions, small talk before business
- discovery: Asking about the prospect's shop, operations, equipment, pain points
- qualification: Probing budget, timeline, decision process, authority
- equipment_discussion: Technical discussion about specific equipment, specs, sizing, air quality
- objection_handling: Prospect raises concerns, pushback, or resistance
- pricing: Discussing costs, quotes, ROI, payment terms, competitive pricing
- closing: Asking for next steps, commitment, scheduling follow-up
- small_talk: Non-business conversation (weather, sports, family, vacations)

SENTIMENT — customer emotional state.
- customer: positive (engaged, interested, warm), neutral (polite but uncommitted), negative (frustrated, annoyed), guarded (skeptical, arms-crossed), hostile (angry, confrontational, wants off the call)
- momentum: building (getting more engaged over time), steady (no change), declining (losing interest), tanking (actively disengaging or getting angry)

SUGGESTION — a response hint for the caller. ONLY emit when the customer asks a direct question, raises a concern, or shows buying interest. Must be 1-2 sentences max. Set to null when no actionable moment exists. Do not suggest something for every chunk — most chunks should have null.
- trigger: MUST be exactly one of these 4 values: "question", "objection", "buying_interest", "exit_assist". No other values allowed.
- confidence: 0.0-1.0 how confident you are this suggestion is relevant

OBJECTION — when the customer voices a specific sales objection, provide the objection text and a concise rebuttal. Null otherwise.

PREDICTED_NEXT — predict the most likely next question or objection based on conversation trajectory. Pattern is a short keyword phrase (2-4 words) for client-side matching (e.g., "cost comparison", "warranty length", "lead time"). Include a pre-computed suggestion for that prediction. Null if no confident prediction.

PHASE_BANK — when you detect a phase transition (different phase than the previous chunk would have been), provide 3-5 pre-written suggestions appropriate for the new phase. Each has a trigger keyword and suggestion text. Null if no phase change detected.

${PRODUCT_CATALOG}

${OBJECTION_PAIRS}

CRITICAL RULES:
- Respond with ONLY valid JSON. No markdown fences. No explanation text.
- suggestion.text must be 1-2 sentences maximum.
- Set fields to null when not applicable — do not omit them.
- phase_bank entries should have specific, actionable trigger keywords.
- predicted_next.pattern should be 2-4 words, specific enough to match in transcript.

JSON schema (follow EXACTLY):
{"phase":"greeting|discovery|qualification|equipment_discussion|objection_handling|pricing|closing|small_talk","sentiment":{"customer":"positive|neutral|negative|guarded|hostile","momentum":"building|steady|declining|tanking"},"suggestion":{"text":"1-2 sentences","trigger":"question|objection|buying_interest|exit_assist","confidence":0.85}|null,"objection":{"objection":"text","rebuttal":"text"}|null,"predicted_next":{"pattern":"2-4 word keyword","suggestion":{"text":"text","trigger":"question|objection|buying_interest|exit_assist"}}|null,"phase_bank":[{"trigger":"keyword","text":"suggestion text"}]|null}`;

// Pre-built system payload for prompt caching (array format with cache_control)
const SYSTEM_PAYLOAD = [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
];

// ── Per-call state ──────────────────────────────────────────────────────
//
// A callId traverses three states:
//
//   1. LIVE — entry exists in callState, aborted=false. Chunks accumulate,
//      cycles fire, broadcasts go out.
//
//   2. ABORTED-BUT-IN-FLIGHT — cleanupConversation has been called while a
//      Haiku fetch is still pending. state.aborted=true; entry removed from
//      callState; entry added to recentlyAborted. When the fetch resolves,
//      runAnalysis sees state.aborted and returns before any broadcast or
//      counter mutation. In-flight requests can't resurrect a dead call.
//
//   3. CLEANED-UP — no entry in callState; entry in recentlyAborted until
//      the next stale sweep past STALE_THRESHOLD. Late transcript chunks
//      are rejected by processConversationChunk before getState can create
//      zombie state. After eviction, the callId is effectively forgotten;
//      a new call with the same id (Twilio reuses) would start fresh.
//
// Two guards serve different phases:
//   - state.aborted gates POST-AWAIT broadcasts (phase 2).
//   - recentlyAborted gates NEW-CHUNK arrivals (phase 3).
// Don't collapse them — they protect non-overlapping windows.

const callState = new Map();

// Callers that have been cleaned up. Prevents zombie state when a late
// transcript chunk arrives after cleanupConversation — without this,
// getState would auto-create fresh state for a dead call and the pipeline
// would happily fire Haiku against a disconnected WebSocket. Entries are
// evicted by the stale sweep after STALE_THRESHOLD.
const recentlyAborted = new Map();  // callId -> abortedAt timestamp

function initState() {
  const now = Date.now();
  return {
    buffer: [],
    // lastAnalysis: batch-timer clock — advances only when runAnalysis
    // commits to calling the model.
    // lastActivity: stale-sweep clock — advances on every chunk arrival,
    // so a call that's receiving audio but not firing cycles (e.g. all
    // short chunks under the 50-char floor) still counts as alive.
    lastAnalysis: now,
    lastActivity: now,
    aborted: false,          // set by cleanupConversation to gate post-await broadcasts
    history: [],             // [{ text, ts }] — rolling transcript window
    lastPhase: null,
    prediction: null,        // Tier 0 (stored for future use)
    phaseBank: [],           // Tier 1 (stored for future use)
    sentimentHistory: [],    // rolling, capped at MAX_SENTIMENT_HISTORY
    analysisInFlight: false,
    consecutiveFailures: 0,
    eventLog: [],            // timestamped events for post-call debrief
  };
}

function getState(callId) {
  if (!callState.has(callId)) callState.set(callId, initState());
  return callState.get(callId);
}

// ── Event log helpers ───────────────────────────────────────────────────

function logNav(state, type, data) {
  state.eventLog.push({ ts: Date.now(), type, ...data });
}

/**
 * Get the event log for a call. Returns a copy (does not consume).
 * Must be called BEFORE cleanupConversation destroys the state.
 */
function getCallEventLog(callId) {
  const state = callState.get(callId);
  if (!state) return null;
  return [...state.eventLog];
}

// ── Haiku API call ──────────────────────────────────────────────────────

async function callHaiku(callId, transcriptWindow) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

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
        max_tokens: 1024,
        system: SYSTEM_PAYLOAD,
        messages: [{ role: 'user', content: `Analyze this transcript chunk:\n\n${transcriptWindow}` }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logEvent('error', 'conversation-pipeline', `Haiku API ${res.status}: ${body.substring(0, 200)}`, { detail: { callId } });
      return null;
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text || '';

    // Strip markdown fences if present. Haiku sometimes emits fenced output
    // on one line (no trailing newline) — the `\n?` on both ends handles
    // both multi-line and single-line fence shapes.
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?\s*```\s*$/, '');
    cleaned = cleaned.trim();
    if (!cleaned.startsWith('{')) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);
    }

    return JSON.parse(cleaned);
  } catch (err) {
    clearTimeout(timer);
    logEvent('error', 'conversation-pipeline', `Haiku call failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`, { detail: { callId } });
    return null;
  }
}

// ── Core pipeline ───────────────────────────────────────────────────────

function buildTranscriptWindow(state) {
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  // Trim old entries
  state.history = state.history.filter(h => h.ts >= cutoff);
  return state.history.map(h => h.text).join(' ');
}

function broadcastPhase(callId, state, parsed) {
  if (!parsed.phase || parsed.phase === state.lastPhase) return;
  const prev = state.lastPhase;
  state.lastPhase = parsed.phase;
  broadcast(callId, {
    type: 'conversation_phase',
    data: { phase: parsed.phase, key_topic: parsed.objection?.objection || null },
  });
  logNav(state, 'phase_change', { from: prev, to: parsed.phase });

  if (parsed.phase_bank && parsed.phase_bank.length > 0) {
    state.phaseBank = parsed.phase_bank;
    broadcast(callId, {
      type: 'phase_bank_loaded',
      data: { phase: parsed.phase, suggestions: parsed.phase_bank },
    });
  }
}

function broadcastSentiment(callId, state, parsed) {
  if (!parsed.sentiment) return;
  state.sentimentHistory.push({
    customer: parsed.sentiment.customer,
    momentum: parsed.sentiment.momentum,
    ts: Date.now(),
  });
  // Cap at MAX_SENTIMENT_HISTORY. In-place shift keeps the array identity
  // stable (avoids the slice-and-replace alloc every cycle). At n=20 the
  // shift re-index cost is trivial; if this ever grows, switch to a ring
  // buffer.
  if (state.sentimentHistory.length > MAX_SENTIMENT_HISTORY) {
    state.sentimentHistory.shift();
  }
  broadcast(callId, {
    type: 'sentiment_update',
    data: {
      customer: parsed.sentiment.customer,
      momentum: parsed.sentiment.momentum,
      history: state.sentimentHistory,
    },
  });
}

function broadcastSuggestion(callId, state, parsed, sourceTag) {
  if (!parsed.suggestion) return;
  broadcast(callId, {
    type: 'response_suggestion',
    data: { ...parsed.suggestion, source: sourceTag },
  });
  logNav(state, 'suggestion', { trigger: parsed.suggestion.trigger, source: sourceTag });
  logEvent('info', 'conversation-pipeline',
    `suggestion served | callId=${callId} source=${sourceTag} trigger=${parsed.suggestion.trigger}`);
}

function broadcastObjection(callId, state, parsed) {
  if (!parsed.objection) return;
  broadcast(callId, {
    type: 'objection_detected',
    data: parsed.objection,
  });
  logNav(state, 'objection', { objection: parsed.objection.objection });
}

// Broadcast on change (including null) to clear stale client ref. A
// prediction from 8s ago that didn't match is worse than no prediction:
// it can fire on a keyword that's no longer trajectory-relevant. The
// client distinguishes explicit null (clear ref) from an absent field
// (ignore), so the `|| null` normalization is load-bearing.
//
// Dedupe on pattern-string equality, not object identity: parsed comes
// from JSON.parse so every cycle allocates fresh objects, and identity
// comparison would never short-circuit. Pattern is the match key the
// client uses for Tier 0 — if it hasn't changed, the client's ref is
// already correct and the broadcast is noise.
function broadcastPrediction(callId, state, parsed) {
  const nextPrediction = parsed.predicted_next || null;
  const prevPattern = state.prediction?.pattern ?? null;
  const nextPattern = nextPrediction?.pattern ?? null;
  if (prevPattern === nextPattern) return;
  state.prediction = nextPrediction;
  broadcast(callId, {
    type: 'prediction_loaded',
    data: nextPrediction,
  });
}

// Single default site for sourceTag — runAnalysis passes through a caller-
// supplied tag explicitly, while direct test callers fall back to tier3.
function handleAnalysisResult(callId, state, parsed, sourceTag = DEFAULT_SOURCE_TAG) {
  broadcastPhase(callId, state, parsed);
  broadcastSentiment(callId, state, parsed);

  // Exit-assist: hostile/tanking 2+ consecutive cycles. Gated on
  // parsed.sentiment because the check reads sentimentHistory's tail —
  // without a fresh push, we'd re-evaluate stale data every cycle and
  // re-fire on the same pair. Suppression of the model's own suggestion
  // stays here so the back-to-back-card guard is visible at the top level.
  let exitAssistFired = false;
  if (parsed.sentiment) {
    const recent = state.sentimentHistory.slice(-2);
    if (recent.length >= 2) {
      const allHostile = recent.every(s => s.customer === 'hostile' || s.momentum === 'tanking');
      if (allHostile && (!parsed.suggestion || parsed.suggestion.trigger !== 'exit_assist')) {
        broadcast(callId, {
          type: 'response_suggestion',
          data: {
            text: "I appreciate your time — let me send you some information and we can reconnect when the timing is better.",
            trigger: 'exit_assist',
            confidence: 0.95,
            source: EXIT_ASSIST_SOURCE_TAG,
          },
        });
        logNav(state, 'exit_assist', { reason: 'hostile/tanking 2+ cycles' });
        logEvent('info', 'conversation-pipeline',
          `suggestion served | callId=${callId} source=${EXIT_ASSIST_SOURCE_TAG} trigger=exit_assist`);
        exitAssistFired = true;
      }
    }
  }

  if (parsed.suggestion && exitAssistFired) {
    logEvent('info', 'conversation-pipeline',
      `suggestion suppressed | callId=${callId} reason=exit_assist_active trigger=${parsed.suggestion.trigger}`);
  } else {
    broadcastSuggestion(callId, state, parsed, sourceTag);
  }

  broadcastObjection(callId, state, parsed);
  broadcastPrediction(callId, state, parsed);
}

async function runAnalysis(callId, state, { sourceTag } = {}) {
  // runAnalysis requires an explicit tag from the caller — processConversationChunk
  // passes DEFAULT_SOURCE_TAG for batched cycles and BYPASS_SOURCE_TAG for
  // question-fire. handleAnalysisResult absorbs the default at the end of
  // the chain if anything slips through.
  if (state.analysisInFlight) return;

  // Evaluate window FIRST — a no-op early return must not reset the timer,
  // otherwise a steady stream of short chunks (all under the 50-char floor)
  // could keep extending the 8s window indefinitely.
  const window = buildTranscriptWindow(state);
  if (!window || window.length < 50) return;

  state.analysisInFlight = true;
  const bufferLenAtStart = state.buffer.length;
  // Reset timer now that we're committed to work. On failure we still want
  // the 8s window to restart so the next cycle isn't timer-expired forever.
  state.lastAnalysis = Date.now();

  const startedAt = Date.now();
  const parsed = await callHaiku(callId, window);
  const latency = Date.now() - startedAt;
  state.analysisInFlight = false;

  // The call may have ended mid-await — don't broadcast to a cleaned-up call
  // and don't mutate failure counters on state that was freed.
  if (state.aborted) return;

  if (!parsed) {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
      broadcast(callId, { type: 'navigator_status', data: { status: 'degraded' } });
    }
    return;
  }

  // Only clear chunks that existed when this cycle started. Chunks that
  // arrived during the in-flight analysis stay in the buffer so the next
  // cycle picks them up immediately instead of waiting a full 8s window.
  state.buffer = state.buffer.slice(bufferLenAtStart);
  // Broadcast recovery BEFORE resetting the counter — the condition checks
  // the pre-reset value to know whether we were actually in degraded mode.
  if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
    broadcast(callId, { type: 'navigator_status', data: { status: 'ok' } });
  }
  state.consecutiveFailures = 0;

  logEvent('info', 'conversation-pipeline',
    `analysis cycle | callId=${callId} source=${sourceTag} latency=${latency}ms phase=${parsed.phase || '-'}`);

  handleAnalysisResult(callId, state, parsed, sourceTag);
}

/**
 * Process an incoming transcript chunk. Fire-and-forget from the caller's perspective.
 * Accumulates text and triggers Haiku analysis when buffer thresholds are met.
 */
async function processConversationChunk(callId, text) {
  if (!text || typeof text !== 'string') return;

  // Refuse late chunks for already-cleaned-up calls. Without this guard,
  // getState auto-creates fresh state and the pipeline resurrects a dead
  // call — firing Haiku, broadcasting to a closed WebSocket, and sitting
  // in memory until the next stale sweep.
  if (recentlyAborted.has(callId)) return;

  const state = getState(callId);
  const now = Date.now();

  // Add to rolling history window. lastActivity advances on every chunk so
  // the stale sweep sees the call as alive even when no cycle fires.
  state.history.push({ text, ts: now });
  state.buffer.push(text);
  state.lastActivity = now;

  // Short-circuit: if a cycle is already running, it will cover the same
  // window content. Skip both the question-fire and batched paths — the
  // guard is duplicated inside runAnalysis as defense-in-depth, but we
  // make it explicit here so the two trigger paths share one check.
  if (state.analysisInFlight) return;

  // Tier 2: question-signal immediate fire. Side effect: runAnalysis resets
  // state.lastAnalysis on commit, so firing here also restarts the 8s batch
  // window. Intentional — we just analyzed the current transcript.
  if (QUESTION_REGEX.test(text)) {
    await runAnalysis(callId, state, { sourceTag: BYPASS_SOURCE_TAG });
    return;
  }

  const elapsed = now - state.lastAnalysis;
  const bufferFull = state.buffer.length >= MIN_BUFFER_CHUNKS;
  const timerExpired = elapsed >= BUFFER_INTERVAL_MS;

  if (bufferFull || timerExpired) {
    await runAnalysis(callId, state, { sourceTag: DEFAULT_SOURCE_TAG });
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanupConversation(callId) {
  const state = callState.get(callId);
  if (state) state.aborted = true;   // gate any in-flight post-await broadcasts
  callState.delete(callId);
  // Only record the first abort timestamp — repeated cleanup calls must NOT
  // extend the zombie-guard window past its original expiry.
  if (!recentlyAborted.has(callId)) recentlyAborted.set(callId, Date.now());
}

// ── Stale state sweep ───────────────────────────────────────────────────
// Follows pattern from stale-sweep.js: interval with .unref() so it
// doesn't keep the process alive.

const SWEEP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [callId, state] of callState) {
    // lastActivity, not lastAnalysis — the sweep measures "no chunks in
    // 30 min," not "no cycles in 30 min." A call with short chunks under
    // the 50-char floor is still alive.
    if (now - state.lastActivity > STALE_THRESHOLD) {
      state.aborted = true;
      callState.delete(callId);
      recentlyAborted.set(callId, now);
      logEvent('sweep', 'conversation-pipeline', `stale state cleared: ${callId}`);
    }
  }
  // Evict recentlyAborted entries past the stale window — no risk of late
  // chunks after this long; keeping them would leak memory.
  for (const [callId, abortedAt] of recentlyAborted) {
    if (now - abortedAt > STALE_THRESHOLD) recentlyAborted.delete(callId);
  }
}, SWEEP_INTERVAL);
sweepInterval.unref();

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  processConversationChunk,
  cleanupConversation,
  getCallEventLog,
  // Exposed for testing
  _callState: callState,
  _recentlyAborted: recentlyAborted,
  _initState: initState,
  _handleAnalysisResult: handleAnalysisResult,
  _buildTranscriptWindow: buildTranscriptWindow,
  _QUESTION_REGEX: QUESTION_REGEX,
};
