import { formatTime } from '../../lib/format';

// Header is always dark — hardcode badge colors against dark bg
const STATUS_BADGE = {
  pre: { bg: 'rgba(59,130,246,0.15)', color: '#93C5FD', label: 'Pre-call', pulse: false },
  active: { bg: 'rgba(34,197,94,0.15)', color: '#4ADE80', label: 'On call', pulse: true },
  post: { bg: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)', label: 'Post-call', pulse: false },
};

export default function CockpitHeader({ callPhase, timer, onThemeToggle, theme, onBack, onRefresh, refreshing }) {
  const badge = STATUS_BADGE[callPhase] || STATUS_BADGE.pre;

  return (
    <div
      className="sticky top-0 z-20 flex items-center justify-between px-5 h-[52px]"
      style={{ background: 'var(--cockpit-header-bg)', borderBottom: '1px solid var(--cockpit-header-border)' }}
    >
      <div className="flex items-center gap-3.5">
        <img src="/joruva-logo-white.svg" alt="Joruva" className="h-[22px] block" />
        <div className="w-px h-[26px] bg-white/[0.12]" />
        {callPhase === 'pre' && (
          <button onClick={onBack} className="text-[13px] text-white/45 hover:text-white/70 transition-colors hidden md:block">
            &larr; Back
          </button>
        )}
        <span className="text-sm font-medium text-white">Call cockpit</span>
      </div>

      <div className="flex items-center gap-3">
        {callPhase === 'active' && (
          <span className="text-sm font-semibold tabular-nums text-[#4ADE80]">
            {formatTime(timer)}
          </span>
        )}

        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-2xl text-xs font-medium"
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
          <svg className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        <button
          onClick={onThemeToggle}
          className="flex items-center gap-1.5 px-2.5 py-[5px] rounded-[20px] border border-white/15 bg-white/[0.08] text-xs font-medium text-white/80 cursor-pointer hover:bg-white/[0.12] transition-colors"
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          <span className="text-sm">{theme === 'light' ? '☀️' : '🌙'}</span>
          <span>{theme === 'light' ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </div>
  );
}
