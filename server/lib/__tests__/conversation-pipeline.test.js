/**
 * conversation-pipeline.test.js — Unit tests for the Conversation Navigator pipeline.
 */

// Mock broadcast before requiring the module
const mockBroadcast = jest.fn();
jest.mock('../live-analysis', () => ({
  broadcast: mockBroadcast,
}));

const mockLogEvent = jest.fn();
jest.mock('../debug-log', () => ({
  logEvent: (...args) => mockLogEvent(...args),
}));

// Suppress fetch calls — we mock callHaiku results via _handleAnalysisResult
const {
  processConversationChunk,
  cleanupConversation,
  getCallEventLog,
  _callState: callState,
  _recentlyAborted: recentlyAborted,
  _initState: initState,
  _handleAnalysisResult: handleAnalysisResult,
  _buildTranscriptWindow: buildTranscriptWindow,
  _QUESTION_REGEX: QUESTION_REGEX,
} = require('../conversation-pipeline');

// Build a fake Haiku fetch response. Accepts partial overrides.
// NOTE: default payload has predicted_next=null, which triggers an
// always-broadcast `prediction_loaded` event with null data. Tests that
// count broadcasts by type must account for this.
function mockHaikuResponse(overrides = {}) {
  const payload = {
    phase: 'discovery',
    sentiment: { customer: 'neutral', momentum: 'steady' },
    suggestion: null,
    objection: null,
    predicted_next: null,
    phase_bank: null,
    ...overrides,
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text: JSON.stringify(payload) }] }),
    text: async () => '',
  };
}

beforeEach(() => {
  callState.clear();
  recentlyAborted.clear();
  mockBroadcast.mockClear();
  mockLogEvent.mockClear();
});

describe('buffer accumulation', () => {
  it('does not trigger analysis before 3 chunks or 8s', async () => {
    // processConversationChunk will try to call Haiku, but ANTHROPIC_API_KEY is not set
    // so it returns early. We test the state management.
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await processConversationChunk('test-1', 'hello');
    await processConversationChunk('test-1', 'world');

    const state = callState.get('test-1');
    expect(state).toBeDefined();
    expect(state.buffer).toHaveLength(2);
    expect(state.history).toHaveLength(2);

    process.env.ANTHROPIC_API_KEY = prev;
  });

  it('accumulates chunks in buffer and history', async () => {
    const state = initState();
    callState.set('test-buf', state);

    // Simulate adding chunks without triggering analysis (no API key)
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    await processConversationChunk('test-buf', 'chunk one');
    await processConversationChunk('test-buf', 'chunk two');

    expect(state.buffer).toEqual(['chunk one', 'chunk two']);
    expect(state.history).toHaveLength(2);
    expect(state.history[0].text).toBe('chunk one');

    process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe('buildTranscriptWindow', () => {
  it('returns concatenated text from history', () => {
    const state = initState();
    state.history = [
      { text: 'Hello Mike', ts: Date.now() - 5000 },
      { text: 'How are you', ts: Date.now() - 2000 },
    ];
    const window = buildTranscriptWindow(state);
    expect(window).toBe('Hello Mike How are you');
  });

  it('trims entries older than 60s', () => {
    const state = initState();
    state.history = [
      { text: 'old chunk', ts: Date.now() - 120000 },  // 2 min ago
      { text: 'recent chunk', ts: Date.now() - 5000 },
    ];
    const window = buildTranscriptWindow(state);
    expect(window).toBe('recent chunk');
    expect(state.history).toHaveLength(1);
  });
});

describe('handleAnalysisResult', () => {
  it('broadcasts phase change when phase differs from lastPhase', () => {
    const state = initState();
    callState.set('test-phase', state);

    handleAnalysisResult('test-phase', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
    });

    expect(state.lastPhase).toBe('discovery');
    const phaseCall = mockBroadcast.mock.calls.find(c => c[1].type === 'conversation_phase');
    expect(phaseCall).toBeDefined();
    expect(phaseCall[1].data.phase).toBe('discovery');
  });

  it('does NOT re-broadcast same phase (dedup)', () => {
    const state = initState();
    state.lastPhase = 'discovery';
    callState.set('test-dedup', state);

    handleAnalysisResult('test-dedup', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
    });

    const phaseCalls = mockBroadcast.mock.calls.filter(c => c[1].type === 'conversation_phase');
    expect(phaseCalls).toHaveLength(0);
  });

  it('broadcasts sentiment_update every cycle', () => {
    const state = initState();
    callState.set('test-sent', state);

    handleAnalysisResult('test-sent', state, {
      phase: 'discovery',
      sentiment: { customer: 'positive', momentum: 'building' },
    });

    const sentCall = mockBroadcast.mock.calls.find(c => c[1].type === 'sentiment_update');
    expect(sentCall).toBeDefined();
    expect(sentCall[1].data.customer).toBe('positive');
    expect(sentCall[1].data.history).toHaveLength(1);
  });

  it('caps sentimentHistory at 20 entries', () => {
    const state = initState();
    // Pre-fill with 20 entries
    for (let i = 0; i < 20; i++) {
      state.sentimentHistory.push({ customer: 'neutral', momentum: 'steady', ts: Date.now() - (20 - i) * 8000 });
    }
    callState.set('test-cap', state);

    handleAnalysisResult('test-cap', state, {
      phase: 'discovery',
      sentiment: { customer: 'positive', momentum: 'building' },
    });

    expect(state.sentimentHistory).toHaveLength(20);
    expect(state.sentimentHistory[state.sentimentHistory.length - 1].customer).toBe('positive');
  });

  it('broadcasts response_suggestion when present', () => {
    const state = initState();
    callState.set('test-sug', state);

    handleAnalysisResult('test-sug', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      suggestion: { text: 'Ask about their CFM needs', trigger: 'question', confidence: 0.8 },
    });

    const sugCall = mockBroadcast.mock.calls.find(c => c[1].type === 'response_suggestion');
    expect(sugCall).toBeDefined();
    expect(sugCall[1].data.text).toBe('Ask about their CFM needs');
    expect(sugCall[1].data.source).toBe('tier3_batch');
  });

  it('broadcasts objection_detected when present', () => {
    const state = initState();
    callState.set('test-obj', state);

    handleAnalysisResult('test-obj', state, {
      phase: 'objection_handling',
      sentiment: { customer: 'guarded', momentum: 'declining' },
      objection: { objection: 'Too expensive', rebuttal: 'ROI in 18 months' },
    });

    const objCall = mockBroadcast.mock.calls.find(c => c[1].type === 'objection_detected');
    expect(objCall).toBeDefined();
    expect(objCall[1].data.objection).toBe('Too expensive');
  });

  it('emits exit-assist when hostile/tanking for 2+ cycles', () => {
    const state = initState();
    state.sentimentHistory = [
      { customer: 'hostile', momentum: 'tanking', ts: Date.now() - 8000 },
    ];
    callState.set('test-exit', state);

    handleAnalysisResult('test-exit', state, {
      phase: 'objection_handling',
      sentiment: { customer: 'hostile', momentum: 'tanking' },
    });

    const exitCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'response_suggestion' && c[1].data.trigger === 'exit_assist'
    );
    expect(exitCall).toBeDefined();
  });

  it('does NOT emit exit-assist when hostile for only 1 cycle', () => {
    const state = initState();
    callState.set('test-no-exit', state);

    handleAnalysisResult('test-no-exit', state, {
      phase: 'objection_handling',
      sentiment: { customer: 'hostile', momentum: 'tanking' },
    });

    const exitCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'response_suggestion' && c[1].data.trigger === 'exit_assist'
    );
    expect(exitCall).toBeUndefined();
  });

  it('broadcasts prediction_loaded when predicted_next present', () => {
    const state = initState();
    callState.set('test-pred', state);

    handleAnalysisResult('test-pred', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      predicted_next: { pattern: 'cost comparison', suggestion: { text: 'Mention ROI', trigger: 'question' } },
    });

    const predCall = mockBroadcast.mock.calls.find(c => c[1].type === 'prediction_loaded');
    expect(predCall).toBeDefined();
    expect(state.prediction).toBeDefined();
    expect(state.prediction.pattern).toBe('cost comparison');
  });

  it('broadcasts phase_bank_loaded on phase change with bank', () => {
    const state = initState();
    callState.set('test-bank', state);

    handleAnalysisResult('test-bank', state, {
      phase: 'qualification',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      phase_bank: [
        { trigger: 'budget', text: 'Ask about budget range' },
        { trigger: 'timeline', text: 'Ask about timeline' },
      ],
    });

    const bankCall = mockBroadcast.mock.calls.find(c => c[1].type === 'phase_bank_loaded');
    expect(bankCall).toBeDefined();
    expect(bankCall[1].data.suggestions).toHaveLength(2);
    expect(state.phaseBank).toHaveLength(2);
  });
});

describe('event log', () => {
  it('accumulates events in eventLog', () => {
    const state = initState();
    callState.set('test-log', state);

    handleAnalysisResult('test-log', state, {
      phase: 'discovery',
      sentiment: { customer: 'positive', momentum: 'building' },
      suggestion: { text: 'Ask about shop', trigger: 'question', confidence: 0.8 },
    });

    expect(state.eventLog.length).toBeGreaterThanOrEqual(2); // phase_change + suggestion
    expect(state.eventLog[0].type).toBe('phase_change');
    expect(state.eventLog[1].type).toBe('suggestion');
  });

  it('getCallEventLog returns a copy', () => {
    const state = initState();
    state.eventLog.push({ ts: Date.now(), type: 'test' });
    callState.set('test-copy', state);

    const log = getCallEventLog('test-copy');
    expect(log).toHaveLength(1);
    log.push({ ts: Date.now(), type: 'extra' });
    expect(state.eventLog).toHaveLength(1); // original unchanged
  });

  it('getCallEventLog returns null for unknown callId', () => {
    expect(getCallEventLog('nonexistent')).toBeNull();
  });
});

describe('source tagging', () => {
  it('stamps suggestion with sourceTag when provided', () => {
    const state = initState();
    callState.set('test-src', state);

    handleAnalysisResult('test-src', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      suggestion: { text: 'Ask about CFM', trigger: 'question', confidence: 0.8 },
    }, 'tier2_question');

    const sugCall = mockBroadcast.mock.calls.find(c => c[1].type === 'response_suggestion');
    expect(sugCall[1].data.source).toBe('tier2_question');
  });

  it('exit-assist broadcast uses source=exit_assist', () => {
    const state = initState();
    state.sentimentHistory = [
      { customer: 'hostile', momentum: 'tanking', ts: Date.now() - 8000 },
    ];
    callState.set('test-exit-src', state);

    handleAnalysisResult('test-exit-src', state, {
      phase: 'objection_handling',
      sentiment: { customer: 'hostile', momentum: 'tanking' },
    });

    const exitCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'response_suggestion' && c[1].data.trigger === 'exit_assist'
    );
    expect(exitCall[1].data.source).toBe('exit_assist');
  });
});

describe('stale prediction clearing', () => {
  it('broadcasts prediction_loaded=null when Haiku returns no prediction', () => {
    const state = initState();
    state.prediction = { pattern: 'old pattern', suggestion: { text: 'old' } };
    callState.set('test-stale', state);

    handleAnalysisResult('test-stale', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      // no predicted_next
    });

    const predCall = mockBroadcast.mock.calls.find(c => c[1].type === 'prediction_loaded');
    expect(predCall).toBeDefined();
    expect(predCall[1].data).toBeNull();
    expect(state.prediction).toBeNull();
  });
});

describe('QUESTION_REGEX', () => {
  const mustMatch = [
    'How much does the JRS-10E cost?',
    'What is your lead time',                     // no trailing ? (ASR may strip)
    'Who handles maintenance',
    'Where are you located',
    'Why would I switch',
    'When can you deliver',
    'Yeah. What about warranty',                  // sentence-boundary wh-word
    'Got it. How does financing work?',
    'So... what we ship is three shifts?',        // trailing ? saves it
  ];

  const mustNotMatch = [
    'Yeah we run three shifts',
    'Is what I said',                             // aux verb — deliberately excluded
    'Do that for me',
    'Can confirm',
    'Would prefer Thursday',
    'Are on schedule',
    'Will be ready Monday',
    'Does the job',
    'Somewhere around noon',                      // "where" mid-word in "somewhere" — \b prevents match
    'Whatever works',                             // "what" mid-word in "whatever"
    // Wh-cleft / relative constructions — these are declaratives that start
    // with a wh-word but are not questions. The regex excludes them via a
    // negative lookahead on subject pronouns (we/i/he/she/they).
    'What we do is three shifts',
    'How we handle it is simple',
    'Why I called was the quote',
    'When he gets in tell him',
    'Where they ship from matters',
  ];

  it.each(mustMatch)('matches question: %s', (text) => {
    expect(QUESTION_REGEX.test(text)).toBe(true);
  });

  it.each(mustNotMatch)('rejects statement: %s', (text) => {
    expect(QUESTION_REGEX.test(text)).toBe(false);
  });

  // Known-leak block: these currently match even though they're declaratives.
  // Documented as accepted false positives in the regex docstring. Pinning
  // current behavior here means a future tightening pass will see which
  // cases it newly rejects (and flip these into mustNotMatch) vs. which
  // cases it still leaks.
  const knownLeaks = [
    'What you need is a bigger compressor',       // "you"-cleft
    'How you handle that is your call',           // "you"-cleft
    "What's needed here is three shifts",          // 's contraction cleft
    "What'd you need",                             // 'd contraction (same class as 's)
    'How come we shipped late',                   // "how come" — ambiguous
  ];

  it.each(knownLeaks)('KNOWN LEAK (currently matches): %s', (text) => {
    expect(QUESTION_REGEX.test(text)).toBe(true);
  });
});

describe('Tier 2 question bypass', () => {
  let originalKey;
  let originalFetch;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // Default: Haiku returns a bare phase+sentiment response.
    global.fetch = jest.fn().mockResolvedValue(mockHaikuResponse());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('question mark triggers bypass and stamps suggestion source=tier2_question', async () => {
    // Haiku returns a suggestion so we can assert the source tag.
    global.fetch = jest.fn().mockResolvedValue(mockHaikuResponse({
      suggestion: { text: 'Quote the JRS-10E at $9,495.', trigger: 'question', confidence: 0.9 },
    }));

    const state = initState();
    state.lastAnalysis = Date.now();
    // Pre-fill history so buildTranscriptWindow clears the 50-char minimum.
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-q', state);

    await processConversationChunk('test-q', 'How much does the JRS-10E cost?');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const sugCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'response_suggestion'
    );
    expect(sugCall).toBeDefined();
    expect(sugCall[1].data.source).toBe('tier2_question');
  });

  it('non-question chunk does NOT trigger bypass (no fetch)', async () => {
    const state = initState();
    state.lastAnalysis = Date.now();                 // timer not expired
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-nq', state);

    await processConversationChunk('test-nq', 'Yeah we run three shifts.');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(state.buffer).toHaveLength(1);
  });

  it('analysisInFlight guards against double-trigger even when buffer is full', async () => {
    const state = initState();
    state.analysisInFlight = true;                   // simulate in-flight cycle
    state.lastAnalysis = Date.now() - 20000;         // timer already expired
    // Pre-fill buffer so bufferFull would otherwise trigger analysis.
    state.buffer = ['filler one', 'filler two'];
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-guard', state);

    // Question chunk: bypass branch would fire, AND buffer-length branch
    // would fire. Both must be suppressed by analysisInFlight.
    await processConversationChunk('test-guard', 'How much is it?');

    expect(global.fetch).not.toHaveBeenCalled();     // no Haiku call at all
    expect(state.buffer).toHaveLength(3);            // chunk appended, not cleared
    expect(state.analysisInFlight).toBe(true);       // unchanged
  });

  it('bypass resets the 8s timer (next timer-driven cycle waits from bypass time)', async () => {
    const state = initState();
    const staleTs = Date.now() - 10000;              // 10s ago — timer would have expired
    state.lastAnalysis = staleTs;
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-timer', state);

    await processConversationChunk('test-timer', 'Why are you calling?');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Prove the timer was actually reset — lastAnalysis must have moved off
    // its pre-call value, not just be "somewhere near now."
    expect(state.lastAnalysis).not.toBe(staleTs);
    // Assert the reset actually moved close to "now" — staleTs was 10s ago,
    // so a real reset must land within 1s of staleTs+10000.
    expect(state.lastAnalysis).toBeGreaterThan(staleTs + 9000);
  });
});

describe('exit-assist suppresses concurrent suggestion', () => {
  it('does NOT also broadcast parsed.suggestion when exit-assist fires', () => {
    const state = initState();
    // 1 prior hostile/tanking entry → this cycle is #2, triggers exit-assist.
    state.sentimentHistory = [
      { customer: 'hostile', momentum: 'tanking', ts: Date.now() - 8000 },
    ];
    callState.set('test-conflict', state);

    handleAnalysisResult('test-conflict', state, {
      phase: 'objection_handling',
      sentiment: { customer: 'hostile', momentum: 'tanking' },
      // Haiku also returned a normal suggestion — should be suppressed.
      suggestion: { text: 'Try the ROI pitch', trigger: 'objection', confidence: 0.7 },
    });

    const suggestionCalls = mockBroadcast.mock.calls.filter(
      c => c[1].type === 'response_suggestion'
    );
    // Exactly one — the exit-assist. The parsed.suggestion must be suppressed.
    expect(suggestionCalls).toHaveLength(1);
    expect(suggestionCalls[0][1].data.trigger).toBe('exit_assist');

    // And the suppression must be logged so downstream hit-rate analysis
    // can reconcile "Haiku suggested N, we served M" — no silent drops.
    const suppressedLog = mockLogEvent.mock.calls.find(
      call => typeof call[2] === 'string' && call[2].includes('suggestion suppressed')
    );
    expect(suppressedLog).toBeDefined();
    // Pin callId AND reason AND trigger — a regression that drops any of
    // these would break downstream hit-rate reconciliation.
    expect(suppressedLog[2]).toMatch(
      /suggestion suppressed \| callId=test-conflict reason=exit_assist_active trigger=objection/
    );
  });
});

describe('cleanup', () => {
  it('removes call state on cleanup', () => {
    callState.set('test-clean', initState());
    expect(callState.has('test-clean')).toBe(true);

    cleanupConversation('test-clean');
    expect(callState.has('test-clean')).toBe(false);
  });

  it('is safe to call on nonexistent callId', () => {
    expect(() => cleanupConversation('nonexistent')).not.toThrow();
  });

  it('sets aborted flag and adds to recentlyAborted on cleanup', () => {
    const state = initState();
    callState.set('test-abort', state);
    expect(state.aborted).toBe(false);

    cleanupConversation('test-abort');

    expect(state.aborted).toBe(true);
    expect(recentlyAborted.has('test-abort')).toBe(true);
  });
});

describe('abort under in-flight Haiku call', () => {
  let originalKey;
  let originalFetch;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('runAnalysis skips broadcasts and counter bumps after cleanup mid-await', async () => {
    // Deferred fetch: we resolve it AFTER calling cleanupConversation so we
    // can observe the post-await branch. Without the aborted check, the
    // post-await code would still broadcast to a dead call.
    let resolveFetch;
    const fetchPromise = new Promise((r) => { resolveFetch = r; });
    global.fetch = jest.fn().mockReturnValue(fetchPromise);

    const state = initState();
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-mid-abort', state);

    // Kick off processConversationChunk but DON'T await it yet — the fetch
    // is pending, so we're inside runAnalysis's `await callHaiku(...)`.
    const chunkPromise = processConversationChunk('test-mid-abort', 'How much?');

    // Let the microtask queue drain so we're definitely inside the await.
    await new Promise((r) => setImmediate(r));

    // Prove we're actually parked mid-await: analysisInFlight is the
    // invariant runAnalysis sets right before calling callHaiku.
    expect(state.analysisInFlight).toBe(true);
    // Baseline: no broadcasts yet (fetch hasn't resolved).
    expect(mockBroadcast).not.toHaveBeenCalled();

    // Call ends while Haiku is pending.
    cleanupConversation('test-mid-abort');
    const broadcastCountAtCleanup = mockBroadcast.mock.calls.length;

    // Now resolve fetch with a response that WOULD have produced broadcasts.
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: JSON.stringify({
        phase: 'discovery',
        sentiment: { customer: 'positive', momentum: 'building' },
        suggestion: { text: 'post-abort ghost', trigger: 'question', confidence: 0.9 },
        objection: null,
        predicted_next: { pattern: 'cost', suggestion: { text: 'x', trigger: 'question' } },
        phase_bank: null,
      }) }] }),
      text: async () => '',
    });

    await chunkPromise;

    // No new broadcasts after cleanup: the aborted branch bailed before
    // touching sentiment/suggestion/prediction broadcasts.
    expect(mockBroadcast.mock.calls.length).toBe(broadcastCountAtCleanup);
    // Direct: the prediction_loaded broadcast must NOT have fired, even
    // though the Haiku response contained a predicted_next payload.
    const predCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'prediction_loaded'
    );
    expect(predCall).toBeUndefined();
    // And the failure counter was NOT bumped on the freed state.
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe('double cleanup', () => {
  it('repeated cleanupConversation does not extend the recentlyAborted TTL', () => {
    cleanupConversation('test-double');
    const firstAbortedAt = recentlyAborted.get('test-double');
    expect(firstAbortedAt).toBeDefined();

    // Second cleanup call 10ms later — must NOT reset the timestamp.
    const after = firstAbortedAt + 10;
    jest.spyOn(Date, 'now').mockReturnValueOnce(after);
    cleanupConversation('test-double');

    expect(recentlyAborted.get('test-double')).toBe(firstAbortedAt);
    Date.now.mockRestore?.();
  });
});

describe('prediction dedupe', () => {
  it('broadcasts prediction_loaded when pattern changes across cycles', () => {
    const state = initState();
    callState.set('test-dedup', state);

    handleAnalysisResult('test-dedup', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      predicted_next: { pattern: 'cost', suggestion: { text: 'A', trigger: 'question' } },
    });
    handleAnalysisResult('test-dedup', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      // New object, same pattern — should NOT re-broadcast.
      predicted_next: { pattern: 'cost', suggestion: { text: 'B', trigger: 'question' } },
    });
    handleAnalysisResult('test-dedup', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      predicted_next: { pattern: 'warranty', suggestion: { text: 'C', trigger: 'question' } },
    });

    const predCalls = mockBroadcast.mock.calls.filter(
      c => c[1].type === 'prediction_loaded'
    );
    // Cycle 1 (null → cost) + cycle 3 (cost → warranty) = 2 broadcasts.
    // Cycle 2 (cost → cost) is deduped.
    expect(predCalls).toHaveLength(2);
    expect(predCalls[0][1].data.pattern).toBe('cost');
    expect(predCalls[1][1].data.pattern).toBe('warranty');
  });

  it('broadcasts prediction_loaded=null when cycle drops a prediction', () => {
    const state = initState();
    state.prediction = { pattern: 'cost', suggestion: { text: 'x', trigger: 'question' } };
    callState.set('test-drop', state);

    handleAnalysisResult('test-drop', state, {
      phase: 'discovery',
      sentiment: { customer: 'neutral', momentum: 'steady' },
      // no predicted_next — client ref must be cleared.
    });

    const predCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'prediction_loaded'
    );
    expect(predCall).toBeDefined();
    expect(predCall[1].data).toBeNull();
    expect(state.prediction).toBeNull();
  });
});

describe('zombie prevention on late chunks', () => {
  let originalKey;
  let originalFetch;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue(mockHaikuResponse());
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it('refuses to process chunks for a callId that was cleaned up', async () => {
    cleanupConversation('test-zombie');           // clean up a call that never existed — adds to recentlyAborted

    await processConversationChunk('test-zombie', 'How much does it cost?');

    // Must not have created fresh state and must not have fired Haiku.
    expect(callState.has('test-zombie')).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses late chunks after real cleanup', async () => {
    // Live call with state.
    const state = initState();
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-late', state);

    cleanupConversation('test-late');

    // Late transcript arrives post-cleanup.
    await processConversationChunk('test-late', 'Why are you calling?');

    expect(callState.has('test-late')).toBe(false);    // not resurrected
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('Haiku fence stripping', () => {
  let originalKey;
  let originalFetch;

  beforeEach(() => {
    originalKey = process.env.ANTHROPIC_API_KEY;
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  const payload = {
    phase: 'discovery',
    sentiment: { customer: 'neutral', momentum: 'steady' },
    suggestion: null,
    objection: null,
    predicted_next: null,
    phase_bank: null,
  };
  const payloadJson = JSON.stringify(payload);

  const fenceShapes = [
    ['multi-line json fence',   '```json\n' + payloadJson + '\n```'],
    ['multi-line bare fence',   '```\n' + payloadJson + '\n```'],
    ['single-line json fence',  '```json ' + payloadJson + ' ```'],
    ['no fence',                payloadJson],
    ['fence + leading prose',   'Sure, here:\n```json\n' + payloadJson + '\n```'],
  ];

  it.each(fenceShapes)('parses payload wrapped as: %s', async (_label, raw) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: raw }] }),
      text: async () => '',
    });

    const state = initState();
    state.history.push({ text: 'x'.repeat(60), ts: Date.now() });
    callState.set('test-fence', state);

    await processConversationChunk('test-fence', 'How much does it cost?');

    // If parsing succeeded, sentiment_update was broadcast. If parsing
    // failed, callHaiku returned null and consecutiveFailures bumped.
    const sentCall = mockBroadcast.mock.calls.find(
      c => c[1].type === 'sentiment_update'
    );
    expect(sentCall).toBeDefined();
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe('lastActivity vs lastAnalysis', () => {
  it('lastActivity advances on every chunk; lastAnalysis only on committed cycle', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;  // force callHaiku early-exit (still won't fire)

    try {
      const state = initState();
      const start = Date.now();
      state.lastAnalysis = start;
      state.lastActivity = start;
      callState.set('test-activity', state);

      await new Promise(r => setTimeout(r, 15));
      // Short chunk (under 50-char window floor). lastActivity must advance.
      await processConversationChunk('test-activity', 'short');

      expect(state.lastActivity).toBeGreaterThan(start);
      // No cycle committed (window too short even with accumulation) —
      // lastAnalysis unchanged.
      expect(state.lastAnalysis).toBe(start);
    } finally {
      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('short-chunk spam does not extend the batch timer', async () => {
    // Regression guard for the "reset timer before length check" bug.
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(mockHaikuResponse());

    try {
      const state = initState();
      const start = Date.now() - 9000;  // timer already expired
      state.lastAnalysis = start;
      state.lastActivity = start;
      callState.set('test-short', state);

      // Three tiny chunks, none reach the 50-char window floor.
      await processConversationChunk('test-short', 'hi');
      await processConversationChunk('test-short', 'ok');
      await processConversationChunk('test-short', 'yep');

      // No fetch fired (window too short) AND lastAnalysis was NOT reset.
      expect(global.fetch).not.toHaveBeenCalled();
      expect(state.lastAnalysis).toBe(start);
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
