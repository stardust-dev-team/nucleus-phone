/**
 * Unit tests for the pure helpers exposed by useLiveAnalysis.js.
 *
 * mergeSentimentUpdate — sentiment_update WS handler merge logic.
 * Filed as nucleus-phone-u0r: prior behavior reset history to [] when the
 * server omitted it, which blanked the sparkline. Defends against contract
 * drift; today the server always sends history.
 */

import { mergeSentimentUpdate } from '../useLiveAnalysis';
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
