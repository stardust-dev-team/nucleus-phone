/**
 * conversation-pipeline.test.js — Unit tests for the Conversation Navigator pipeline.
 */

// Mock broadcast before requiring the module
const mockBroadcast = jest.fn();
jest.mock('../live-analysis', () => ({
  broadcast: mockBroadcast,
}));

jest.mock('../debug-log', () => ({
  logEvent: jest.fn(),
}));

// Suppress fetch calls — we mock callHaiku results via _handleAnalysisResult
const {
  processConversationChunk,
  cleanupConversation,
  getCallEventLog,
  _callState: callState,
  _initState: initState,
  _handleAnalysisResult: handleAnalysisResult,
  _buildTranscriptWindow: buildTranscriptWindow,
} = require('../conversation-pipeline');

beforeEach(() => {
  callState.clear();
  mockBroadcast.mockClear();
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
    expect(sugCall[1].data.source).toBe('haiku');
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
});
