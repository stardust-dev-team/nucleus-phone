import { useMemo } from 'react';
import { formatTime } from '../../lib/format';

const STATUS_BADGE = {
  pre: { bg: 'rgba(59,130,246,0.15)', color: '#93C5FD', label: 'Pre-call', pulse: false },
  active: { bg: 'rgba(34,197,94,0.15)', color: '#4ADE80', label: 'On call', pulse: true },
  post: { bg: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)', label: 'Post-call', pulse: false },
};

export default function CockpitHeader({
  callPhase, timer, onThemeToggle, theme, onBack, onRefresh, refreshing,
  leaderboard, currentUser,
}) {
  const badge = STATUS_BADGE[callPhase] || STATUS_BADGE.pre;

  const me = leaderboard?.find(e => e.identity === currentUser);
  const stats = me ? [
    { label: 'Calls', value: me.callsMade ?? 0, icon: '📞' },
    { label: 'Connects', value: me.leadsQualified ?? 0, icon: '🤝' },
    { label: 'Hot', value: me.hotLeads ?? 0, icon: '🔥' },
    { label: 'Streak', value: me.streak ? `${me.streak}d` : '0d', icon: '⚡' },
  ] : [];

  const sorted = useMemo(() =>
    leaderboard
      ? [...leaderboard].sort((a, b) =>
          (b.leadsQualified || 0) - (a.leadsQualified || 0) || (b.callsMade || 0) - (a.callsMade || 0)
        )
      : [],
    [leaderboard]
  );

  return (
    <div
      className="sticky top-0 z-20 flex items-center justify-between px-4 h-[44px] shrink-0"
      style={{ background: 'var(--cockpit-header-bg)', borderBottom: '1px solid var(--cockpit-header-border)' }}
    >
      {/* Left: logo + back + title */}
      <div className="flex items-center gap-2.5">
        <img src="/joruva-logo-white.svg" alt="Joruva" className="h-[20px] block" />
        <div className="w-px h-[22px] bg-white/[0.12]" />
        {callPhase === 'pre' && (
          <button onClick={onBack} className="text-[12px] text-white/45 hover:text-white/70 transition-colors hidden md:block">
            &larr; Back
          </button>
        )}
        <span className="text-[13px] font-medium text-white">Call cockpit</span>
      </div>

      {/* Center: gamification stats */}
      {stats.length > 0 && (
        <div className="hidden md:flex items-center gap-1.5">
          {stats.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-1 px-2 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              <span className="text-[11px]">{s.icon}</span>
              <span className="text-[12px] font-semibold text-white/90 leading-none">{s.value}</span>
              <span className="text-[9px] text-white/40">{s.label}</span>
            </div>
          ))}
          {sorted.length > 0 && (
            <>
              <div className="w-px h-4 bg-white/10 mx-0.5" />
              <div className="flex items-center gap-0.5">
                {sorted.slice(0, 3).map((m, i) => {
                  const isMe = m.identity === currentUser;
                  return (
                    <span
                      key={m.identity}
                      className="text-[10px] px-1.5 py-[1px] rounded"
                      title={`${m.displayName}: ${m.callsMade} calls`}
                      style={{
                        color: isMe ? '#93C5FD' : 'rgba(255,255,255,0.45)',
                        fontWeight: isMe ? 600 : 400,
                        background: i === 0 ? 'rgba(217,119,6,0.15)' : 'transparent',
                      }}
                    >
                      {i === 0 && '👑 '}{m.displayName || m.identity} {m.callsMade}
                    </span>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Right: status + controls */}
      <div className="flex items-center gap-2">
        {callPhase === 'active' && (
          <span className="text-[13px] font-semibold tabular-nums text-[#4ADE80]">
            {formatTime(timer)}
          </span>
        )}

        <span
          className="inline-flex items-center gap-1 px-2 py-[2px] rounded-2xl text-[11px] font-medium"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.pulse && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#4ADE80] animate-[pulse_1.5s_ease-in-out_infinite]" />
          )}
          {badge.label}
        </span>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="text-white/60 hover:text-white/90 transition-colors disabled:opacity-40"
          title="Refresh intel"
        >
          <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          onClick={onThemeToggle}
          className="flex items-center gap-1 px-2 py-[3px] rounded-[16px] border border-white/15 bg-white/[0.08] text-[11px] font-medium text-white/80 cursor-pointer hover:bg-white/[0.12] transition-colors"
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          <span className="text-[12px]">{theme === 'light' ? '☀️' : '🌙'}</span>
          <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </div>
  );
}
