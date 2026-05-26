import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { MODES } from '../../lib/mode-router';

const STATUS_COLORS = {
  initializing: 'bg-aunshin-sodium',
  ready: 'bg-aunshin-success',
  connecting: 'bg-aunshin-sodium',
  connected: 'bg-aunshin-success',
  error: 'bg-aunshin-alert',
};

export default function Shell({ identity, role, mode, onLogout, deviceStatus, emailReady }) {
  const location = useLocation();
  const navigate = useNavigate();

  // TriStar-mode reps get a Queue tab in place of Contacts as the primary
  // landing surface — the queue IS their inbound work (sequencer-driven),
  // and contacts (signal-driven from joruva.com) is irrelevant. Joruva
  // reps see the original Contacts/Activity/Practice loadout. Identity-
  // based UI is intentionally absent: the mode is the authoritative
  // gate, not the email — same source of truth as api.js routing.
  const tabs = mode === 'tristar'
    ? [
        { path: '/queue', label: 'Queue', icon: '📞' },
        ...(role === 'admin' ? [{ path: '/active', label: 'Live', icon: '📡' }] : []),
        { path: '/activity', label: 'Activity', icon: '📊' },
        { path: '/scoreboard', label: 'Score', icon: '🏆' },
        { path: '/ask', label: 'Ask', icon: '💬' },
      ]
    : [
        { path: '/', label: 'Contacts', icon: '👤' },
        ...(role === 'admin' ? [{ path: '/active', label: 'Live', icon: '📡' }] : []),
        { path: '/activity', label: 'Activity', icon: '📊' },
        { path: '/scoreboard', label: 'Score', icon: '🏆' },
        { path: '/practice', label: 'Practice', icon: '🎯' },
        { path: '/ask', label: 'Ask', icon: '💬' },
      ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-aunshin-twilight-2" style={{ borderBottom: '1px solid rgba(92,57,43,0.3)' }}>
        <div className="flex items-center gap-3">
          <img
            src="/joruva-logo-white.svg"
            alt="Aunshin"
            className="h-6"
          />
          <div className="h-4 w-px" style={{ background: 'rgba(92,57,43,0.4)' }} />
          <span className="text-[11px] font-semibold tracking-[2px] uppercase" style={{ color: '#F2B86A' }}>Phone</span>
        </div>
        <div className="flex items-center gap-3">
          {role === 'admin' && (
            <a
              href="/debug"
              onClick={(e) => { e.preventDefault(); navigate('/debug'); }}
              className="text-[11px] font-semibold tracking-wide transition-colors hover:text-white"
              style={{ color: '#F2B86A', textDecoration: 'none' }}
              title="Debug Dashboard"
              aria-label="Debug Dashboard"
            >
              🔧
            </a>
          )}
          <a
            href="/study-guide.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-semibold tracking-wide transition-colors hover:text-white"
            style={{ color: '#7EC55F', textDecoration: 'none' }}
          >
            Sales Ops Guide
          </a>
          <a
            href="/compressed-air-fundamentals.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] font-semibold tracking-wide transition-colors hover:text-white"
            style={{ color: '#7EC55F', textDecoration: 'none' }}
          >
            Compressor Fundamentals
          </a>
          <div className="h-4 w-px" style={{ background: 'rgba(92,57,43,0.4)' }} />
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[deviceStatus] || 'bg-gray-500'}`} />
            <span className="text-sm capitalize text-aunshin-peach-light">{identity}</span>
          </div>
          <button
            onClick={onLogout}
            className="text-xs transition-colors"
            style={{ color: '#C99A78' }}
          >
            Logout
          </button>
        </div>
      </header>

      {/* Re-login banner for email sending */}
      {emailReady === false && (
        <div className="bg-aunshin-sodium/10 border-b border-aunshin-sodium/30 px-4 py-1.5 text-center text-[11px] text-aunshin-sodium shrink-0">
          <a href="/api/auth/login" className="underline font-medium">Re-login</a> to enable email follow-ups from your mailbox
        </div>
      )}

      {/* Content */}
      <main className="flex-1 overflow-y-auto scroll-container">
        <Outlet />
      </main>

      {/* Bottom nav */}
      <nav className="flex bg-aunshin-twilight-2 pb-[env(safe-area-inset-bottom)]" style={{ borderTop: '1px solid rgba(92,57,43,0.3)' }}>
        {tabs.map((tab) => {
          const active = location.pathname === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className="flex-1 flex flex-col items-center py-3 gap-1 transition-colors"
              style={{ color: active ? '#F2B86A' : '#C99A78' }}
            >
              <span className="text-lg">{tab.icon}</span>
              <span className="text-[10px] font-medium tracking-wider uppercase">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
