import { useMemo } from 'react';
import { formatTime } from '../../lib/format';

const STATUS_BADGE = {
  pre: { bg: 'rgba(201,154,120,0.12)', color: '#C99A78', label: 'Pre-call', pulse: false },
  active: { bg: 'rgba(242,184,106,0.15)', color: '#F2B86A', label: 'On call', pulse: true },
  post: { bg: 'rgba(239,209,175,0.06)', color: 'rgba(239,209,175,0.5)', label: 'Post-call', pulse: false },
};

export default function CockpitHeader({
  callPhase, timer, onThemeToggle, theme, onBack, onRefresh, refreshing,
  leaderboard, currentUser, isPractice, practiceStats,
  navigatorEnabled = true, onNavigatorToggle,
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
      {/* Left: brand mark + module label */}
      <div className="flex items-center gap-2.5">
        <img src="/joruva-logo-white.svg" alt="Aunshin" className="h-[20px] block" />
        <div className="w-px h-[22px]" style={{ background: 'rgba(92,57,43,0.4)' }} />
        {callPhase === 'pre' && (
          <button onClick={onBack} className="text-xs hover:text-white/70 transition-colors hidden md:block" style={{ color: '#C99A78' }}>
            &larr; Back
          </button>
        )}
        <span className="text-[11px] font-semibold tracking-[1.5px] uppercase" style={{ color: '#EFD1AF' }}>Cockpit</span>
      </div>

      {/* Center: gamification stats */}
      {stats.length > 0 && (
        <div className="hidden md:flex items-center gap-1.5">
          {stats.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-1 px-2 py-0.5 rounded-aunshin"
              style={{ background: 'rgba(42,18,19,0.5)' }}
            >
              <span className="text-[11px]">{s.icon}</span>
              <span className="text-[12px] font-semibold leading-none" style={{ color: '#EFD1AF' }}>{s.value}</span>
              <span className="text-[11px]" style={{ color: '#C99A78' }}>{s.label}</span>
            </div>
          ))}
          {sorted.length > 0 && (
            <>
              <div className="w-px h-4 mx-0.5" style={{ background: 'rgba(92,57,43,0.4)' }} />
              <div className="flex items-center gap-0.5">
                {sorted.slice(0, 3).map((m, i) => {
                  const isMe = m.identity === currentUser;
                  return (
                    <span
                      key={m.identity}
                      className="text-[11px] px-1.5 py-[1px] rounded-aunshin"
                      title={`${m.displayName}: ${m.callsMade} calls`}
                      style={{
                        color: isMe ? '#F2B86A' : '#C99A78',
                        fontWeight: isMe ? 600 : 400,
                        background: i === 0 ? 'rgba(242,184,106,0.12)' : 'transparent',
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
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-aunshin" style={{ background: 'var(--cockpit-purple-bg)' }}>
                <span className="text-[11px]">🎯</span>
                <span className="text-[12px] font-semibold leading-none" style={{ color: '#EFD1AF' }}>{practiceStats.practiceCount}</span>
                <span className="text-[11px]" style={{ color: '#C99A78' }}>Practice</span>
              </div>
              {practiceStats.avgScore && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded-aunshin" style={{ background: 'var(--cockpit-purple-bg)' }}>
                  <span className="text-[11px]">📊</span>
                  <span className="text-[12px] font-semibold leading-none" style={{ color: '#EFD1AF' }}>{practiceStats.avgScore}</span>
                  <span className="text-[11px]" style={{ color: '#C99A78' }}>Avg</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Right: status + controls */}
      <div className="flex items-center gap-2">
        {callPhase === 'active' && (
          <span className="text-sm font-semibold tabular-nums" style={{ color: '#F2B86A' }}>
            {formatTime(timer)}
          </span>
        )}

        <span
          className="inline-flex items-center gap-1 px-2 py-[2px] rounded-2xl text-[11px] font-medium"
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.pulse && (
            <span className="w-1.5 h-1.5 rounded-full animate-[pulse_1.5s_ease-in-out_infinite]" style={{ background: '#F2B86A' }} />
          )}
          {badge.label}
        </span>

        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="transition-colors disabled:opacity-40"
          style={{ color: '#C99A78' }}
          title="Refresh intel"
        >
          <svg className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        {onNavigatorToggle && (
          // Colors are hardcoded (not theme-var) on purpose: the header bg is
          // dark navy in both light and dark modes, so this button matches the
          // adjacent theme-toggle's convention. The violet tint signals
          // "intel module" (navigator). Don't CSS-var these without
          // understanding the header doesn't theme-switch.
          <button
            onClick={onNavigatorToggle}
            className="flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium cursor-pointer transition-colors"
            style={{
              borderRadius: '3px',
              border: '1px solid rgba(92,57,43,0.4)',
              background: navigatorEnabled ? 'rgba(201,154,120,0.18)' : 'rgba(42,18,19,0.5)',
              color: navigatorEnabled ? '#C99A78' : '#C99A78',
            }}
            title={`Conversation Navigator ${navigatorEnabled ? 'on' : 'off'}`}
            aria-pressed={navigatorEnabled}
          >
            <span>Nav {navigatorEnabled ? 'on' : 'off'}</span>
          </button>
        )}

        <button
          onClick={onThemeToggle}
          className="flex items-center gap-1 px-2 py-[3px] text-[11px] font-medium cursor-pointer transition-colors"
          style={{
            borderRadius: '3px',
            border: '1px solid rgba(92,57,43,0.4)',
            background: 'rgba(42,18,19,0.5)',
            color: '#C99A78',
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
