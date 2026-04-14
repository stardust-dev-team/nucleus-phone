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

const callState = new Map();

function initState() {
  return {
    buffer: [],
    lastAnalysis: Date.now(),
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

    // Strip markdown fences if present
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n/i, '');
    cleaned = cleaned.replace(/\n```\s*$/, '');
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

function handleAnalysisResult(callId, state, parsed) {
  // Phase change detection + broadcast
  if (parsed.phase && parsed.phase !== state.lastPhase) {
    const prev = state.lastPhase;
    state.lastPhase = parsed.phase;
    broadcast(callId, {
      type: 'conversation_phase',
      data: { phase: parsed.phase, key_topic: parsed.objection?.objection || null },
    });
    logNav(state, 'phase_change', { from: prev, to: parsed.phase });

    // Phase bank (broadcast for future Tier 1 use)
    if (parsed.phase_bank && parsed.phase_bank.length > 0) {
      state.phaseBank = parsed.phase_bank;
      broadcast(callId, {
        type: 'phase_bank_loaded',
        data: { phase: parsed.phase, suggestions: parsed.phase_bank },
      });
    }
  }

  // Sentiment — broadcast every cycle, maintain history
  if (parsed.sentiment) {
    state.sentimentHistory.push({
      customer: parsed.sentiment.customer,
      momentum: parsed.sentiment.momentum,
      ts: Date.now(),
    });
    // Cap at MAX_SENTIMENT_HISTORY
    if (state.sentimentHistory.length > MAX_SENTIMENT_HISTORY) {
      state.sentimentHistory = state.sentimentHistory.slice(-MAX_SENTIMENT_HISTORY);
    }

    broadcast(callId, {
      type: 'sentiment_update',
      data: {
        customer: parsed.sentiment.customer,
        momentum: parsed.sentiment.momentum,
        history: state.sentimentHistory,
      },
    });

    // Hostile/tanking exit-assist detection (2+ consecutive cycles)
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
            source: 'haiku',
          },
        });
        logNav(state, 'exit_assist', { reason: 'hostile/tanking 2+ cycles' });
      }
    }
  }

  // Suggestion — broadcast when present
  if (parsed.suggestion) {
    broadcast(callId, {
      type: 'response_suggestion',
      data: { ...parsed.suggestion, source: 'haiku' },
    });
    logNav(state, 'suggestion', { trigger: parsed.suggestion.trigger });
  }

  // Objection — broadcast when present
  if (parsed.objection) {
    broadcast(callId, {
      type: 'objection_detected',
      data: parsed.objection,
    });
    logNav(state, 'objection', { objection: parsed.objection.objection });
  }

  // Prediction — store for future Tier 0 use
  if (parsed.predicted_next) {
    state.prediction = parsed.predicted_next;
    broadcast(callId, {
      type: 'prediction_loaded',
      data: parsed.predicted_next,
    });
  }
}

async function runAnalysis(callId, state) {
  if (state.analysisInFlight) return;
  state.analysisInFlight = true;
  // Reset timer immediately so the 8s window restarts regardless of outcome.
  // Without this, a failure leaves timerExpired permanently true.
  state.lastAnalysis = Date.now();

  const window = buildTranscriptWindow(state);
  if (!window || window.length < 50) {
    // Not enough content for meaningful analysis (avoids wasting Haiku on "Hello?")
    state.analysisInFlight = false;
    return;
  }

  const parsed = await callHaiku(callId, window);
  state.analysisInFlight = false;

  if (!parsed) {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
      broadcast(callId, { type: 'navigator_status', data: { status: 'degraded' } });
    }
    return;
  }

  // Success — clear buffer and reset failure counter
  state.buffer = [];
  if (state.consecutiveFailures >= DEGRADED_THRESHOLD) {
    broadcast(callId, { type: 'navigator_status', data: { status: 'ok' } });
  }
  state.consecutiveFailures = 0;

  handleAnalysisResult(callId, state, parsed);
}

/**
 * Process an incoming transcript chunk. Fire-and-forget from the caller's perspective.
 * Accumulates text and triggers Haiku analysis when buffer thresholds are met.
 */
async function processConversationChunk(callId, text) {
  if (!text || typeof text !== 'string') return;

  const state = getState(callId);

  // Add to rolling history window
  state.history.push({ text, ts: Date.now() });
  state.buffer.push(text);

  // Check if we should run analysis
  const elapsed = Date.now() - state.lastAnalysis;
  const bufferFull = state.buffer.length >= MIN_BUFFER_CHUNKS;
  const timerExpired = elapsed >= BUFFER_INTERVAL_MS;

  if (bufferFull || timerExpired) {
    await runAnalysis(callId, state);
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────

function cleanupConversation(callId) {
  callState.delete(callId);
}

// ── Stale state sweep ───────────────────────────────────────────────────
// Follows pattern from stale-sweep.js: interval with .unref() so it
// doesn't keep the process alive.

const SWEEP_INTERVAL = 10 * 60 * 1000; // 10 minutes
const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes

const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [callId, state] of callState) {
    if (now - state.lastAnalysis > STALE_THRESHOLD) {
      callState.delete(callId);
      logEvent('sweep', 'conversation-pipeline', `stale state cleared: ${callId}`);
    }
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
  _initState: initState,
  _handleAnalysisResult: handleAnalysisResult,
  _buildTranscriptWindow: buildTranscriptWindow,
};
