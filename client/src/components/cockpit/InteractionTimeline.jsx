import { useState } from 'react';

const OUTCOME_BADGES = {
  hot: { label: 'Hot', bg: 'var(--cockpit-red-bg)', color: 'var(--cockpit-red-text)' },
  warm: { label: 'Warm', bg: 'var(--cockpit-amber-50)', color: 'var(--cockpit-amber-900)' },
  info: { label: 'Info', bg: 'var(--cockpit-blue-50)', color: 'var(--cockpit-blue-900)' },
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getOutcome(entry) {
  if (entry.qualification === 'hot' || entry.disposition === 'hot') return 'hot';
  if (entry.qualification === 'warm' || entry.disposition === 'warm' || entry.disposition === 'interested') return 'warm';
  return 'info';
}

const MAX_VISIBLE = 4;

export default function InteractionTimeline({ interactionHistory, priorCalls }) {
  const [open, setOpen] = useState(true);
  const interactions = interactionHistory?.interactions || [];
  const calls = priorCalls || [];

  const entries = [
    ...interactions.map(i => ({
      agent: 'System',
      action: i.summary || i.disposition || i.intent || 'Interaction',
      date: i.createdAt,
      outcome: i.channel === 'voice' ? 'warm' : 'info',
    })),
    ...calls.map(c => ({
      agent: c.caller_identity || 'Unknown',
      action: `Called — ${c.disposition || 'no disposition'}${c.qualification ? ` (${c.qualification})` : ''}`,
      date: c.created_at,
      outcome: getOutcome(c),
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20);

  if (!entries.length) return null;

  const visible = entries.slice(0, MAX_VISIBLE);
  const hasMore = entries.length > MAX_VISIBLE;

  return (
    <div>
      <div
        className="flex justify-between items-center cursor-pointer"
        style={{ marginBottom: open ? 6 : 0 }}
        onClick={() => setOpen(!open)}
      >
        <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-wider">
          Timeline ({entries.length})
        </div>
        <span className="text-xs text-cp-text-muted">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div
          className="rounded-lg py-2.5 px-3.5 transition-colors duration-300 bg-cp-card border border-cp-border"
        >
          {visible.map((e, i) => {
            const badge = OUTCOME_BADGES[e.outcome] || OUTCOME_BADGES.info;

            return (
              <div
                key={`${e.date}-${e.agent}-${i}`}
                className="flex items-center gap-2.5 py-1.5"
                style={{ borderBottom: i < visible.length - 1 ? '1px solid var(--cockpit-card-border)' : 'none' }}
              >
                <span className="text-xs text-cp-text-muted min-w-[48px] shrink-0">
                  {formatDate(e.date)}
                </span>
                <span className="text-[13px] text-cp-text-secondary flex-1 truncate">
                  <strong className="font-medium text-cp-text">{e.agent}</strong> — {e.action}
                </span>
                <span
                  className="inline-flex items-center px-2 py-[2px] rounded-xl text-[11px] font-medium shrink-0"
                  style={{ background: badge.bg, color: badge.color }}
                >
                  {badge.label}
                </span>
              </div>
            );
          })}
          {hasMore && (
            <div className="text-[11px] text-cp-text-muted text-center pt-1">
              +{entries.length - MAX_VISIBLE} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
