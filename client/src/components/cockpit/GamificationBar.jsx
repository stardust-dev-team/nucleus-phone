import { useMemo } from 'react';

export default function GamificationBar({ leaderboard, currentUser }) {
  if (!leaderboard?.length) return null;

  const me = leaderboard.find(e => e.identity === currentUser);
  const stats = [
    { label: 'Calls', value: me?.callsMade ?? 0, icon: '📞' },
    { label: 'Connects', value: me?.leadsQualified ?? 0, icon: '🤝' },
    { label: 'Hot leads', value: me?.hotLeads ?? 0, icon: '🔥' },
    { label: 'Streak', value: me?.streak ? `${me.streak}d` : '0d', icon: '⚡' },
  ];

  const sorted = useMemo(() =>
    [...leaderboard].sort((a, b) =>
      (b.leadsQualified || 0) - (a.leadsQualified || 0) || (b.callsMade || 0) - (a.callsMade || 0)
    ), [leaderboard]);

  return (
    <div
      className="flex items-center justify-between gap-3 px-5 py-2 flex-wrap transition-colors duration-300"
      style={{
        background: 'var(--cockpit-gamify-bg)',
        borderBottom: '1px solid var(--cockpit-gamify-border)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-cp-text">{me?.displayName || currentUser}</span>
        <div className="w-px h-5" style={{ background: 'var(--cockpit-card-border)' }} />
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md"
            style={{ background: 'var(--cockpit-gamify-stat-bg)' }}
          >
            <span className="text-[13px]">{s.icon}</span>
            <span className="text-sm font-semibold text-cp-text leading-none">{s.value}</span>
            <span className="text-[10px] text-cp-text-muted">{s.label}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[11px] text-cp-text-muted mr-1">Team:</span>
        {sorted.map((m, i) => {
          const isMe = m.identity === currentUser;
          const isLeader = i === 0;
          return (
            <div
              key={m.identity}
              title={`${m.displayName}: ${m.callsMade} calls, ${m.leadsQualified} qualified`}
              className="flex items-center gap-[3px] px-2 py-[3px] rounded-md cursor-default"
              style={{
                background: isLeader ? 'var(--cockpit-amber-50)' : 'transparent',
                border: isMe ? '1.5px solid var(--cockpit-blue-500)' : '1.5px solid transparent',
              }}
            >
              {isLeader && <span className="text-[11px]">👑</span>}
              <span
                className="text-[11px]"
                style={{
                  fontWeight: isLeader ? 600 : 500,
                  color: isLeader ? 'var(--cockpit-amber-900)' : 'var(--cockpit-text-secondary)',
                }}
              >
                {m.displayName || m.identity}
              </span>
              <span className="text-[10px] text-cp-text-muted tabular-nums">{m.callsMade}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
