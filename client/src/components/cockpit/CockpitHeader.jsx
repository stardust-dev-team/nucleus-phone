import { useMemo } from 'react';
import { formatTime } from '../../lib/format';

const STATUS_BADGE = {
  pre: { bg: 'rgba(139,92,246,0.12)', color: '#A78BFA', label: 'Pre-call', pulse: false },
  active: { bg: 'rgba(245,158,11,0.15)', color: '#F59E0B', label: 'On call', pulse: true },
  post: { bg: 'rgba(245,245,244,0.06)', color: 'rgba(245,245,244,0.5)', label: 'Post-call', pulse: false },
};

export default function CockpitHeader({
  callPhase, timer, onThemeToggle, theme, onBack, onRefresh, refreshing,
  leaderboard, currentUser, isPractice, practiceStats,
}) {
  const badge = isPractice
    ? { bg: 'var(--cockpit-purple-bg)', color: 'var(--cockpit-purple-500)', label: 'Practice', pulse: false }
    : (STATUS_BADGE[callPhase] || STATUS_BADGE.pre);

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
      {/* Left: Sentinel mark + module label */}
      <div className="flex items-center gap-2.5">
        <img src="/joruva-logo-white.svg" alt="Nucleus" className="h-[20px] block" />
        <div className="w-px h-[22px]" style={{ background: 'rgba(49,46,129,0.4)' }} />
        {callPhase === 'pre' && (
          <button onClick={onBack} className="text-[12px] hover:text-white/70 transition-colors hidden md:block" style={{ color: '#78716C' }}>
            &larr; Back
          </button>
        )}
        <span className="text-[13px] font-semibold tracking-wider uppercase" style={{ color: '#F5F5F4' }}>Cockpit</span>
      </div>

      {/* Center: gamification stats */}
      {stats.length > 0 && (
        <div className="hidden md:flex items-center gap-1.5">
          {stats.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-1 px-2 py-0.5 rounded-sentinel"
              style={{ background: 'rgba(30,27,75,0.5)' }}
            >
              <span className="text-[11px]">{s.icon}</span>
              <span className="text-[12px] font-semibold leading-none" style={{ color: '#F5F5F4' }}>{s.value}</span>
              <span className="text-[9px]" style={{ color: '#78716C' }}>{s.label}</span>
            </div>
          ))}
          {sorted.length > 0 && (
            <>
              <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(49,46,129,0.4)' }} />
              <div className="flex items-center gap-0.5">
                {sorted.slice(0, 3).map((m, i) => {
                  const isMe = m.identity === currentUser;
                  return (
                    <span
                      key={m.identity}
                      className="text-[10px] px-1.5 py-[1px] rounded-sentinel"
                      title={`${m.displayName}: ${m.callsMade} calls`}
                      style={{
                        color: isMe ? '#F59E0B' : '#78716C',
                        fontWeight: isMe ? 600 : 400,
                        background: i === 0 ? 'rgba(245,158,11,0.12)' : 'transparent',
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

      {/* Center: practice stats (when in practice mode) */}
      {isPractice && practiceStats && (
        <div className="hidden md:flex items-center gap-1.5">
          {practiceStats.practiceCount > 0 && (
            <>
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-sentinel" style={{ background: 'var(--cockpit-purple-bg)' }}>
                <span className="text-[11px]">🎯</span>
                <span className="text-[12px] font-semibold leading-none" style={{ color: '#F5F5F4' }}>{practiceStats.practiceCount}</span>
                <span className="text-[9px]" style={{ color: '#78716C' }}>Practice</span>
              </div>
              {practiceStats.avgScore && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-sentinel" style={{ background: 'var(--cockpit-purple-bg)' }}>
                  <span className="text-[11px]">📊</span>
                  <span className="text-[12px] font-semibold leading-none" style={{ color: '#F5F5F4' }}>{practiceStats.avgScore}</span>
                  <span className="text-[9px]" style={{ color: '#78716C' }}>Avg</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Right: status + controls */}
      <div className="flex items-center gap-2">
        {callPhase === 'active' && (
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: '#F59E0B' }}>
            {formatTime(timer)}
          </span>
        )}

        <span
          className="inline-flex items-center gap-1 px-2 py-[2px] rounded-2xl text-[11px] font-medium"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.pulse && (
            <span className="w-1.5 h-1.5 rounded-full animate-[pulse_1.5s_ease-in-out_infinite]" style={{ background: '#F59E0B' }} />
          )}
          {badge.label}
        </span>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="transition-colors disabled:opacity-40"
          style={{ color: '#78716C' }}
          title="Refresh intel"
        >
          <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          onClick={onThemeToggle}
          className="flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium cursor-pointer transition-colors"
          style={{
            borderRadius: '3px',
            border: '1px solid rgba(49,46,129,0.4)',
            background: 'rgba(15,13,41,0.5)',
            color: '#A8A29E',
          }}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          <span className="text-[12px]">{theme === 'light' ? '☀️' : '🌙'}</span>
          <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </div>
  );
}
