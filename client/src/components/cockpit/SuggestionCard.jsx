import { useEffect, useRef } from 'react';

const AUTO_DISMISS_MS = 30_000;

const SOURCE_LABEL = {
  prediction: 'predicted',
  phase_bank: 'phase',
  haiku: 'live',
  exit_assist: 'exit',
};

/**
 * SuggestionCard — single-slot, auto-dismissing response suggestion.
 *
 * Design:
 * - Expands to fit full suggestion text (no line clamp).
 * - Violet left accent for normal suggestions; amber for exit_assist /
 *   objection rebuttals (styling is driven by `suggestion.trigger`).
 * - Auto-dismiss after 30s. Replacement resets the timer.
 * - Parent guarantees `suggestion` is non-null before rendering.
 *
 * `onDismiss` is stashed in a ref so the effect dep list is just the receive
 * timestamp — callers don't have to guarantee a memoized callback to keep
 * the timer from thrashing on every parent render.
 */
export default function SuggestionCard({ suggestion, onDismiss }) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current?.(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [suggestion._receivedAt]);

  const trigger = suggestion.trigger || 'default';
  const isExit = trigger === 'exit_assist' || trigger === 'objection';
  const accent = isExit
    ? 'var(--cockpit-amber-600, #B07A0C)'
    : 'var(--cockpit-nav-suggest-accent, var(--cockpit-blue-500))';
  const bg = isExit
    ? 'var(--cockpit-amber-50, #FFF9EE)'
    : 'var(--cockpit-nav-suggest-bg, var(--cockpit-blue-50))';

  const sourceLabel = SOURCE_LABEL[suggestion.source] || null;

  return (
    <div
      className="flex items-start gap-3 px-3 py-2.5 rounded"
      style={{
        background: bg,
        border: `1px solid ${accent}`,
        borderLeftWidth: '3px',
      }}
      role="status"
      aria-live="polite"
      data-trigger={trigger}
    >
      <div className="flex-1 min-w-0">
        <p
          className="text-[13px] leading-[1.4]"
          style={{ color: 'var(--cockpit-text)' }}
        >
          {suggestion.text}
        </p>
        {sourceLabel && (
          <span
            className="inline-block mt-1 text-[9px] font-semibold tracking-[1px] uppercase px-1.5 py-[1px] rounded"
            style={{
              background: 'rgba(0,0,0,0.05)',
              color: 'var(--cockpit-text-muted)',
            }}
          >
            {sourceLabel}
          </span>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="shrink-0 text-[11px] leading-none px-1.5 py-1 rounded hover:bg-black/5 transition-colors"
        style={{ color: 'var(--cockpit-text-muted)' }}
        aria-label="Dismiss suggestion"
      >
        ✕
      </button>
    </div>
  );
}
