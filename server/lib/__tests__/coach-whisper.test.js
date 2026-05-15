/**
 * coach-whisper.test.js — Unit tests for the Advisory-tier coach-whisper module.
 *
 * The pure decision function (`_shouldEmit`) is exercised with fixture
 * state directly. The full `maybeEmitCoachWhisper` path mocks `fetch`
 * and `broadcast` so we can assert the Haiku request shape and the
 * resulting `coach_whisper` envelope without hitting the network.
 *
 * An integration test gated by `INTEGRATION=1` calls the real Haiku
 * endpoint to assert the response shape parses correctly. Skipped by
 * default — opt in with `INTEGRATION=1 npm test -- coach-whisper`.
 */

// Mock the live-analysis broadcast helper before requiring the module.
const mockBroadcast = jest.fn();
jest.mock('../live-analysis', () => ({
  broadcast: mockBroadcast,
}));

const mockLogEvent = jest.fn();
jest.mock('../debug-log', () => ({
  logEvent: (...args) => mockLogEvent(...args),
}));

const {
  maybeEmitCoachWhisper,
  cleanupCoachWhisperState,
  _coachState: coachState,
  _shouldEmit: shouldEmit,
  _SYSTEM_PROMPT: SYSTEM_PROMPT,
  _SYSTEM_PAYLOAD: SYSTEM_PAYLOAD,
  _MIN_COOLDOWN_MS: MIN_COOLDOWN_MS,
} = require('../coach-whisper');

// Helper: build a conversation-pipeline-shaped state object.
function buildState({
  lastPhase = 'discovery',
  customerSentiment = 'neutral',
  historyText = 'rep: tell me about your operation. customer: we run two shifts on rotary screws.',
  aborted = false,
} = {}) {
  return {
    lastPhase,
    sentimentHistory: customerSentiment
      ? [{ customer: customerSentiment, momentum: 'steady', ts: Date.now() }]
      : [],
    history: historyText ? [{ text: historyText, ts: Date.now() }] : [],
    aborted,
  };
}

// Helper: mock an Anthropic response with the given pacing-nudge text.
function mockHaikuFetchOK(text) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text: JSON.stringify({ text }) }] }),
    text: async () => '',
  }));
}

beforeEach(() => {
  coachState.clear();
  mockBroadcast.mockClear();
  mockLogEvent.mockClear();
});

describe('shouldEmit (pure decision)', () => {
  it('emits when phase shifts and cooldown elapsed', () => {
    const ws = { lastEmitAt: 0, lastEmittedPhase: 'greeting', lastEmittedSentiment: 'neutral', inFlight: false };
    expect(shouldEmit({
      now: MIN_COOLDOWN_MS + 1,
      ws,
      phaseNow: 'discovery',
      sentimentNow: 'neutral',
    })).toBe(true);
  });

  it('emits when sentiment shifts and cooldown elapsed', () => {
    const ws = { lastEmitAt: 0, lastEmittedPhase: 'discovery', lastEmittedSentiment: 'neutral', inFlight: false };
    expect(shouldEmit({
      now: MIN_COOLDOWN_MS + 1,
      ws,
      phaseNow: 'discovery',
      sentimentNow: 'guarded',
    })).toBe(true);
  });

  it('suppresses when nothing has changed', () => {
    const ws = { lastEmitAt: 0, lastEmittedPhase: 'discovery', lastEmittedSentiment: 'neutral', inFlight: false };
    expect(shouldEmit({
      now: MIN_COOLDOWN_MS + 1,
      ws,
      phaseNow: 'discovery',
      sentimentNow: 'neutral',
    })).toBe(false);
  });

  it('suppresses during cooldown even on phase shift', () => {
    const ws = { lastEmitAt: 1000, lastEmittedPhase: 'greeting', lastEmittedSentiment: 'neutral', inFlight: false };
    // 1000 + MIN_COOLDOWN - 1 < lastEmitAt + MIN_COOLDOWN, still in window.
    expect(shouldEmit({
      now: 1000 + MIN_COOLDOWN_MS - 1,
      ws,
      phaseNow: 'discovery',
      sentimentNow: 'neutral',
    })).toBe(false);
  });

  it('suppresses while inFlight even on phase shift past cooldown', () => {
    const ws = { lastEmitAt: 0, lastEmittedPhase: 'greeting', lastEmittedSentiment: 'neutral', inFlight: true };
    expect(shouldEmit({
      now: MIN_COOLDOWN_MS * 2,
      ws,
      phaseNow: 'discovery',
      sentimentNow: 'guarded',
    })).toBe(false);
  });

  it('does not arm on null phase/sentiment', () => {
    const ws = { lastEmitAt: 0, lastEmittedPhase: null, lastEmittedSentiment: null, inFlight: false };
    expect(shouldEmit({
      now: MIN_COOLDOWN_MS + 1,
      ws,
      phaseNow: null,
      sentimentNow: null,
    })).toBe(false);
  });
});

describe('maybeEmitCoachWhisper', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('broadcasts coach_whisper with snake_case fields on first phase shift', async () => {
    global.fetch = mockHaikuFetchOK('Slow down on the price reveal.');

    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'neutral' });
    await maybeEmitCoachWhisper('call-A', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const [callId, envelope] = mockBroadcast.mock.calls[0];
    expect(callId).toBe('call-A');
    expect(envelope.type).toBe('coach_whisper');
    expect(envelope.data.source).toBe('ai');
    expect(envelope.data.author_name).toBe('Aunshin Coach');
    expect(envelope.data.text).toBe('Slow down on the price reveal.');
    // ISO 8601 timestamp — Date(ts).toISOString() round-trips this format
    // on the iOS side via JSONDecoder.dateDecodingStrategy.iso8601.
    expect(typeof envelope.data.ts).toBe('string');
    expect(envelope.data.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('sends the cached system payload + user message containing phase + sentiment', async () => {
    const fetchMock = mockHaikuFetchOK('Phase shifted; drop the discovery questions.');
    global.fetch = fetchMock;

    const state = buildState({ lastPhase: 'pricing', customerSentiment: 'positive' });
    await maybeEmitCoachWhisper('call-B', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);

    // System is the cached array payload — single source of truth for
    // the prompt + ephemeral-cache annotation.
    expect(body.system).toEqual(SYSTEM_PAYLOAD);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.model).toBe('claude-haiku-4-5-20251001');

    // User content carries the current pacing context.
    const userText = body.messages[0].content;
    expect(userText).toContain('Current phase: pricing');
    expect(userText).toContain('Customer sentiment: positive');
    expect(userText).toContain('rotary screws');
  });

  it('suppresses second emit when neither phase nor sentiment changed', async () => {
    global.fetch = mockHaikuFetchOK('Stay specific.');

    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'neutral' });
    await maybeEmitCoachWhisper('call-C', state, { now: MIN_COOLDOWN_MS + 1 });
    // Same phase + sentiment, well past cooldown — should NOT emit.
    await maybeEmitCoachWhisper('call-C', state, { now: MIN_COOLDOWN_MS * 5 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('suppresses when inFlight already true', async () => {
    // Pre-seed the state map with inFlight=true.
    coachState.set('call-D', {
      lastEmitAt: 0,
      lastEmittedPhase: 'greeting',
      lastEmittedSentiment: 'neutral',
      inFlight: true,
    });

    global.fetch = mockHaikuFetchOK('should not fire');
    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'guarded' });
    await maybeEmitCoachWhisper('call-D', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('suppresses when transcript window is below MIN_WINDOW_CHARS', async () => {
    global.fetch = mockHaikuFetchOK('should not fire');
    const state = buildState({
      lastPhase: 'discovery',
      customerSentiment: 'neutral',
      historyText: 'short',
    });
    await maybeEmitCoachWhisper('call-E', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not broadcast when call has aborted mid-Haiku', async () => {
    // fetch resolves; but we flip state.aborted between fetch returning
    // and the post-await broadcast — same gate runAnalysis uses.
    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'guarded' });
    global.fetch = jest.fn(async () => {
      state.aborted = true;   // call ended mid-await
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ text: JSON.stringify({ text: 'nudge' }) }] }),
        text: async () => '',
      };
    });

    await maybeEmitCoachWhisper('call-F', state, { now: MIN_COOLDOWN_MS + 1 });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('drops empty-text response (Haiku says "no pacing issue")', async () => {
    global.fetch = mockHaikuFetchOK('');
    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'positive' });
    await maybeEmitCoachWhisper('call-G', state, { now: MIN_COOLDOWN_MS + 1 });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('clears inFlight after Haiku failure so the next tick can retry', async () => {
    // Non-ok fetch — Haiku call returns null.
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'upstream error',
    }));

    const state = buildState({ lastPhase: 'discovery', customerSentiment: 'guarded' });
    await maybeEmitCoachWhisper('call-H', state, { now: MIN_COOLDOWN_MS + 1 });

    const ws = coachState.get('call-H');
    expect(ws.inFlight).toBe(false);
  });

  it('re-emits when phase shifts again past cooldown', async () => {
    global.fetch = mockHaikuFetchOK('first');
    const state1 = buildState({ lastPhase: 'discovery', customerSentiment: 'neutral' });
    await maybeEmitCoachWhisper('call-I', state1, { now: MIN_COOLDOWN_MS + 1 });

    global.fetch = mockHaikuFetchOK('second');
    const state2 = buildState({ lastPhase: 'pricing', customerSentiment: 'neutral' });
    await maybeEmitCoachWhisper('call-I', state2, { now: MIN_COOLDOWN_MS * 3 });

    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast.mock.calls[0][1].data.text).toBe('first');
    expect(mockBroadcast.mock.calls[1][1].data.text).toBe('second');
  });

  it('strips ```json``` fences if Haiku adds them', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '```json\n{"text":"Drop the discovery questions."}\n```' }],
      }),
      text: async () => '',
    }));

    const state = buildState({ lastPhase: 'pricing', customerSentiment: 'guarded' });
    await maybeEmitCoachWhisper('call-J', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast.mock.calls[0][1].data.text).toBe('Drop the discovery questions.');
  });
});

describe('cleanupCoachWhisperState', () => {
  it('removes the call entry without affecting other calls', () => {
    coachState.set('call-keep', { lastEmitAt: 1, lastEmittedPhase: 'discovery', lastEmittedSentiment: 'neutral', inFlight: false });
    coachState.set('call-drop', { lastEmitAt: 2, lastEmittedPhase: 'pricing', lastEmittedSentiment: 'guarded', inFlight: false });

    cleanupCoachWhisperState('call-drop');

    expect(coachState.has('call-drop')).toBe(false);
    expect(coachState.has('call-keep')).toBe(true);
  });

  it('is a no-op for unknown callIds', () => {
    expect(() => cleanupCoachWhisperState('never-existed')).not.toThrow();
  });
});

describe('integration (real Haiku)', () => {
  const enabled = process.env.INTEGRATION === '1' && process.env.ANTHROPIC_API_KEY;

  // Skip block — only runs with INTEGRATION=1 + a real key. Useful for
  // manually verifying prompt shape against live Haiku without spending
  // credits on every CI run.
  (enabled ? it : it.skip)('produces a parseable pacing nudge from a real Haiku call', async () => {
    const state = buildState({
      lastPhase: 'pricing',
      customerSentiment: 'guarded',
      historyText:
        'rep: so the QSI-30 runs about nineteen-five. customer: yeah we are not really there yet on budget. ' +
        'rep: totally get it. we can talk about a smaller unit. how many cfm are you typically pulling?',
    });

    await maybeEmitCoachWhisper('call-INT', state, { now: MIN_COOLDOWN_MS + 1 });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const envelope = mockBroadcast.mock.calls[0][1];
    expect(envelope.type).toBe('coach_whisper');
    expect(typeof envelope.data.text).toBe('string');
    expect(envelope.data.text.length).toBeGreaterThan(0);
    expect(envelope.data.source).toBe('ai');
  }, 15000);
});

describe('prompt contract', () => {
  it('system prompt mentions pacing and forbids markdown/quotes', () => {
    expect(SYSTEM_PROMPT).toMatch(/pacing/i);
    expect(SYSTEM_PROMPT).toMatch(/JSON object/);
    expect(SYSTEM_PROMPT).toMatch(/no markdown/i);
  });
});
