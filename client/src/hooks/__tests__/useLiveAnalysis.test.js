/**
 * Unit tests for the pure helpers exposed by useLiveAnalysis.js.
 *
 * mergeSentimentUpdate — sentiment_update WS handler merge logic.
 * Filed as nucleus-phone-u0r: prior behavior reset history to [] when the
 * server omitted it, which blanked the sparkline. Defends against contract
 * drift; today the server always sends history.
 */

import { mergeSentimentUpdate, normalizeForPredictionMatch } from '../useLiveAnalysis';
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
