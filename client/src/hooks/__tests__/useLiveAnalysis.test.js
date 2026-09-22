/**
 * Unit tests for the pure helpers exposed by useLiveAnalysis.js.
 *
 * mergeSentimentUpdate — sentiment_update WS handler merge logic.
 * Filed as nucleus-phone-u0r: prior behavior reset history to [] when the
 * server omitted it, which blanked the sparkline. Defends against contract
 * drift; today the server always sends history.
 */

import { renderHook, act } from '@testing-library/react';
import useLiveAnalysis, { mergeSentimentUpdate, normalizeForPredictionMatch } from '../useLiveAnalysis';
import { SENTIMENT_HISTORY_MAX } from '../../components/cockpit/navigator-constants';

describe('mergeSentimentUpdate', () => {
  test('returns prev unchanged when data is null/undefined', () => {
    const prev = { customer: 'positive', momentum: 'steady', history: [{ t: 1 }] };
    expect(mergeSentimentUpdate(prev, null)).toBe(prev);
    expect(mergeSentimentUpdate(prev, undefined)).toBe(prev);
  });

  test('takes server-provided history verbatim (truncated to window)', () => {
    const history = Array.from({ length: SENTIMENT_HISTORY_MAX + 5 }, (_, i) => ({ t: i }));
    const merged = mergeSentimentUpdate(null, { customer: 'positive', momentum: 'steady', history });

    expect(merged.history).toHaveLength(SENTIMENT_HISTORY_MAX);
    // Truncation keeps the most recent entries (slice -N).
    expect(merged.history[0]).toEqual({ t: 5 });
    expect(merged.history[merged.history.length - 1]).toEqual({ t: SENTIMENT_HISTORY_MAX + 4 });
  });

  test('preserves prior history when server omits history[] (the u0r fix)', () => {
    const prev = {
      customer: 'positive',
      momentum: 'steady',
      history: [{ t: 1 }, { t: 2 }, { t: 3 }],
    };
    const merged = mergeSentimentUpdate(prev, { customer: 'neutral', momentum: 'declining' });

    expect(merged.history).toEqual([{ t: 1 }, { t: 2 }, { t: 3 }]);
    expect(merged.customer).toBe('neutral');
    expect(merged.momentum).toBe('declining');
  });

  test('empty server history wins (server is the canonical source)', () => {
    const prev = {
      customer: 'positive',
      momentum: 'steady',
      history: [{ t: 1 }, { t: 2 }],
    };
    const merged = mergeSentimentUpdate(prev, { customer: 'neutral', momentum: 'steady', history: [] });

    // Server explicitly sent an empty window → respect it. This is different
    // from omitting `history`, which preserves prior. Useful when the server
    // intentionally clears state at phase boundaries.
    expect(merged.history).toEqual([]);
  });

  test('falls back to [] when prev has no history and server omits history', () => {
    const merged = mergeSentimentUpdate(null, { customer: 'neutral', momentum: 'steady' });
    expect(merged.history).toEqual([]);
  });

  test('non-array history in payload is treated as missing (preserves prior)', () => {
    // Defends against malformed server payload — e.g. history sent as a string
    // by accident. Treat as missing rather than crash.
    const prev = { customer: 'positive', momentum: 'steady', history: [{ t: 1 }] };
    const merged = mergeSentimentUpdate(prev, { customer: 'neutral', history: 'not-an-array' });

    expect(merged.history).toEqual([{ t: 1 }]);
  });

  test('returns a new object — does not mutate prev', () => {
    const prev = { customer: 'positive', momentum: 'steady', history: [{ t: 1 }] };
    const merged = mergeSentimentUpdate(prev, { customer: 'neutral', momentum: 'declining' });

    expect(merged).not.toBe(prev);
    expect(prev.customer).toBe('positive');
  });
});

/**
 * Tier 0 prediction matching normalization (nucleus-phone-ioy).
 *
 * ASR output frequently contains incidental whitespace and punctuation
 * variants that the .toLowerCase().includes() path used to miss:
 * 'how  much' (double space), 'how-much', "it's" vs 'its'. Normalize both
 * pattern and text before substring-matching so author-written patterns
 * survive transcription noise.
 */
describe('normalizeForPredictionMatch', () => {
  test('lowercases and trims', () => {
    expect(normalizeForPredictionMatch('  HOW MUCH  ')).toBe('how much');
  });

  test('collapses double-spaces and tabs', () => {
    expect(normalizeForPredictionMatch('how  much')).toBe('how much');
    expect(normalizeForPredictionMatch('how\t\tmuch')).toBe('how much');
    expect(normalizeForPredictionMatch('how\nmuch')).toBe('how much');
  });

  test('hyphens normalize to spaces (how-much → how much)', () => {
    expect(normalizeForPredictionMatch('how-much')).toBe('how much');
  });

  test('apostrophes drop entirely so "it\'s" → "its" (not "it s")', () => {
    // Linus pass #2: substituting apostrophe with space leaves "it s",
    // which doesn't match a pattern of "its". Drop the apostrophe instead.
    expect(normalizeForPredictionMatch("it's")).toBe('its');
    expect(normalizeForPredictionMatch("can't")).toBe('cant');
    expect(normalizeForPredictionMatch("don't")).toBe('dont');
    // Pattern 'cant' must match both "can't" and "cant" via substring.
    const pattern = normalizeForPredictionMatch('cant');
    expect(normalizeForPredictionMatch("can't do this").includes(pattern)).toBe(true);
    expect(normalizeForPredictionMatch('I cant do this').includes(pattern)).toBe(true);
  });

  test('punctuation (commas, periods, quotes, parens) normalize to spaces', () => {
    expect(normalizeForPredictionMatch('How much, exactly?')).toBe('how much exactly');
    // Quotes drop entirely (Linus #2 — same reasoning as apostrophes);
    // commas/question marks substitute with space then collapse.
    expect(normalizeForPredictionMatch('"is it cheap?"')).toBe('is it cheap');
    expect(normalizeForPredictionMatch('(cost) [tax]')).toBe('cost tax');
  });

  test('non-string inputs return empty string', () => {
    expect(normalizeForPredictionMatch(undefined)).toBe('');
    expect(normalizeForPredictionMatch(null)).toBe('');
    expect(normalizeForPredictionMatch(123)).toBe('');
    expect(normalizeForPredictionMatch({})).toBe('');
  });

  test('substring matching after normalization handles realistic ASR variants', () => {
    // ASR delivers 'How much is it?' as 'how  much is it'; pattern 'how much'
    // must match.
    const pattern = normalizeForPredictionMatch('how much');
    expect(normalizeForPredictionMatch('How  much is it?').includes(pattern)).toBe(true);
    expect(normalizeForPredictionMatch('How-much, really?').includes(pattern)).toBe(true);
    expect(normalizeForPredictionMatch('HOWMUCH').includes(pattern)).toBe(false);
  });

  test('idempotent — normalize(normalize(x)) === normalize(x)', () => {
    const inputs = ['How  much', 'cost-effective', "it's a deal!", '  ALL CAPS  '];
    for (const s of inputs) {
      const once = normalizeForPredictionMatch(s);
      const twice = normalizeForPredictionMatch(once);
      expect(twice).toBe(once);
    }
  });
});

/**
 * WS `coach_whisper` handling (bead copilot-699).
 *
 * The server (server/lib/coach-whisper.js -> conversation-pipeline.js)
 * broadcasts `{type: 'coach_whisper', data: {...}}` over the same socket
 * as `response_suggestion`, but the hook's onmessage switch had no case
 * for it — it fell through to `default: return` and was silently dropped.
 * These tests prove the case exists, routes into its own `whisperHistory`
 * state (never conflated with `suggestionHistory` — separate two-font-canon
 * channels, see LiveContainer.jsx), and caps at the same last-5 window as
 * suggestionHistory.
 */
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    MockWebSocket.instances.push(this);
  }
  send() {}
  close(code, reason) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}
MockWebSocket.instances = [];

describe('useLiveAnalysis — coach_whisper WS handling', () => {
  const originalWebSocket = global.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    global.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
  });

  function openSocket(result) {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => { ws.onopen(); });
    return ws;
  }

  function sendMessage(ws, msg) {
    act(() => { ws.onmessage({ data: JSON.stringify(msg) }); });
  }

  test('coach_whisper is stored in whisperHistory, not dropped', () => {
    const { result } = renderHook(() => useLiveAnalysis('call-123', true));
    const ws = openSocket(result);

    sendMessage(ws, {
      type: 'coach_whisper',
      data: { source: 'ai', author_name: 'Aunshin Coach', text: 'Slow down on price.', ts: '2026-09-21T00:00:00.000Z' },
    });

    expect(result.current.whisperHistory).toHaveLength(1);
    expect(result.current.whisperHistory[0].text).toBe('Slow down on price.');
    expect(result.current.whisperHistory[0]).toHaveProperty('_seq');
  });

  test('coach_whisper never lands in suggestionHistory — separate channel', () => {
    const { result } = renderHook(() => useLiveAnalysis('call-456', true));
    const ws = openSocket(result);

    sendMessage(ws, { type: 'coach_whisper', data: { text: 'Let them finish.' } });

    expect(result.current.suggestionHistory).toHaveLength(0);
    expect(result.current.whisperHistory).toHaveLength(1);
  });

  test('whisperHistory caps at the last 5 entries, like suggestionHistory', () => {
    const { result } = renderHook(() => useLiveAnalysis('call-789', true));
    const ws = openSocket(result);

    for (let i = 0; i < 7; i++) {
      sendMessage(ws, { type: 'coach_whisper', data: { text: `whisper ${i}` } });
    }

    expect(result.current.whisperHistory).toHaveLength(5);
    expect(result.current.whisperHistory[4].text).toBe('whisper 6');
  });
});
