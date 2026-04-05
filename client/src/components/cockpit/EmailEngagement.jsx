import Sparkline from '../ui/Sparkline';

function relativeTime(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const EVENT_STYLES = {
  open:  { dot: 'var(--cockpit-blue-500, #3B82F6)', label: 'Opened' },
  click: { dot: 'var(--cockpit-green-500, #22C55E)', label: 'Clicked' },
  reply: { dot: 'var(--cockpit-amber-600, #D97706)', label: 'Replied' },
};

export default function EmailEngagement({ emailEngagement }) {
  if (!emailEngagement?.length) return null;

  // Group by campaign
  const campaigns = {};
  for (const e of emailEngagement) {
    const name = e.campaign_name || 'Unknown campaign';
    if (!campaigns[name]) campaigns[name] = [];
    campaigns[name].push(e);
  }

  // Sparkline data: engagement count per day (last 14 days)
  const now = Date.now();
  const dayBuckets = Array.from({ length: 14 }, (_, i) => {
    const dayStart = now - (13 - i) * 86400000;
    const dayEnd = dayStart + 86400000;
    return emailEngagement.filter(e => {
      const t = new Date(e.created_at).getTime();
      return t >= dayStart && t < dayEnd;
    }).length;
  });
  const hasActivity = dayBuckets.some(v => v > 0);

  return (
    <div className="mb-3">
      <div className="text-[11px] font-semibold text-cp-text-muted uppercase tracking-[1.5px] mb-1.5">
        Email engagement
      </div>
      <div className="rounded py-2.5 px-3.5 bg-cp-card border border-cp-border">
        {/* Sparkline + summary */}
        <div className="flex items-center gap-3 mb-2">
          {hasActivity && <Sparkline data={dayBuckets} width={100} height={24} />}
          <span className="text-xs text-cp-text-muted">
            {emailEngagement.filter(e => e.event_type === 'open').length} opens,{' '}
            {emailEngagement.filter(e => e.event_type === 'click').length} clicks
          </span>
        </div>

        {/* Event timeline */}
        {Object.entries(campaigns).map(([name, events]) => (
          <div key={name}>
            <div className="text-[10px] font-semibold text-cp-text-muted mb-1">{name}</div>
            {events.slice(0, 4).map((e, i) => {
              const style = EVENT_STYLES[e.event_type] || EVENT_STYLES.open;
              return (
                <div key={i} className="flex items-center gap-2 py-0.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: style.dot }}
                  />
                  <span className="text-xs text-cp-text">{style.label}</span>
                  <span className="text-[10px] text-cp-text-muted ml-auto">
                    {relativeTime(e.created_at)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
