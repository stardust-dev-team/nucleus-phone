// Surfaces the most recent prior call's disposition, date, and AI summary.
// Renders null when there are no prior calls, the latest call has no summary yet,
// OR the caller was API-key-authed (server strips ai_summary — see cockpit.js:226).

const DISPOSITION_STYLE = {
  qualified_hot:      { label: 'Hot',        bar: 'var(--cockpit-red-text)',   pillBg: 'var(--cockpit-red-bg)',   pillText: 'var(--cockpit-red-text)' },
  qualified_warm:     { label: 'Warm',       bar: 'var(--cockpit-amber-600)',  pillBg: 'var(--cockpit-amber-50)', pillText: 'var(--cockpit-amber-900)' },
  callback_requested: { label: 'Callback',   bar: 'var(--cockpit-amber-600)',  pillBg: 'var(--cockpit-amber-50)', pillText: 'var(--cockpit-amber-900)' },
  interested:         { label: 'Interested', bar: 'var(--cockpit-green-500)',  pillBg: 'var(--cockpit-green-50)', pillText: 'var(--cockpit-green-500)' },
  connected:          { label: 'Connected',  bar: 'var(--cockpit-blue-500)',   pillBg: 'var(--cockpit-blue-50)',  pillText: 'var(--cockpit-blue-900)' },
  not_interested:     { label: 'Pass',       bar: 'var(--cockpit-red-text)',   pillBg: 'var(--cockpit-red-bg)',   pillText: 'var(--cockpit-red-text)' },
  no_answer:          { label: 'No answer',  bar: 'var(--cockpit-card-border)', pillBg: 'var(--cockpit-card)',    pillText: 'var(--cockpit-text-muted)' },
  voicemail:          { label: 'Voicemail',  bar: 'var(--cockpit-card-border)', pillBg: 'var(--cockpit-card)',    pillText: 'var(--cockpit-text-muted)' },
};

const FALLBACK_STYLE = { label: 'Prior call', bar: 'var(--cockpit-card-border)', pillBg: 'var(--cockpit-card)', pillText: 'var(--cockpit-text-muted)' };

function formatRelative(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatAbsolute(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

export default function LastCallCard({ priorCalls }) {
  const last = priorCalls?.[0];
  if (!last?.ai_summary) return null;

  const style = DISPOSITION_STYLE[last.disposition] || FALLBACK_STYLE;
  const caller = last.caller_identity ? last.caller_identity.split('@')[0] : null;

  return (
    <div
      className="flex items-stretch rounded-lg overflow-hidden mb-3 bg-cp-card border border-cp-border"
      title={formatAbsolute(last.created_at)}
    >
      <div className="w-1 shrink-0" style={{ background: style.bar }} />
      <div className="flex-1 min-w-0 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="cp-label text-cp-text-muted uppercase tracking-wide text-[10px] font-semibold">
            Last call
          </span>
          <span
            className="inline-flex items-center px-2 py-[1px] rounded text-[10px] font-semibold"
            style={{ background: style.pillBg, color: style.pillText }}
          >
            {style.label}
          </span>
          <span className="text-[11px] text-cp-text-muted">
            {formatRelative(last.created_at)}
            {caller && ` · ${caller}`}
          </span>
        </div>
        <p
          className="text-sm text-cp-text-secondary leading-snug"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {last.ai_summary}
        </p>
      </div>
    </div>
  );
}
