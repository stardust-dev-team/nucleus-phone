import { useLocation, useNavigate, Outlet } from 'react-router-dom';

const STATUS_COLORS = {
  initializing: 'bg-jv-amber',
  ready: 'bg-jv-green',
  connecting: 'bg-jv-amber',
  connected: 'bg-jv-green',
  error: 'bg-jv-red',
};

export default function Shell({ identity, role, onLogout, deviceStatus }) {
  const location = useLocation();
  const navigate = useNavigate();

  const tabs = [
    { path: '/', label: 'Contacts', icon: '👤' },
    ...(role === 'admin' ? [{ path: '/active', label: 'Live', icon: '📡' }] : []),
    { path: '/history', label: 'History', icon: '📋' },
    { path: '/scoreboard', label: 'Score', icon: '🏆' },
    { path: '/pipeline', label: 'Pipeline', icon: '📊' },
    { path: '/practice', label: 'Practice', icon: '🎯' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header — Sentinel Abyss */}
      <header className="flex items-center justify-between px-4 py-3 bg-jv-card" style={{ borderBottom: '1px solid rgba(49,46,129,0.3)' }}>
        <div className="flex items-center gap-3">
          <img
            src="/joruva-logo-white.svg"
            alt="Nucleus"
            className="h-6"
          />
          <div className="h-4 w-px" style={{ background: 'rgba(49,46,129,0.4)' }} />
          <span className="text-[11px] font-semibold tracking-[2px] uppercase" style={{ color: '#F97316' }}>Phone</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[deviceStatus] || 'bg-gray-500'}`} />
            <span className="text-sm capitalize text-jv-bone">{identity}</span>
          </div>
          <button
            onClick={onLogout}
            className="text-xs transition-colors"
            style={{ color: '#78716C' }}
          >
            Logout
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto scroll-container">
        <Outlet />
      </main>

      {/* Bottom nav — Sentinel */}
      <nav className="flex bg-jv-card pb-[env(safe-area-inset-bottom)]" style={{ borderTop: '1px solid rgba(49,46,129,0.3)' }}>
        {tabs.map((tab) => {
          const active = location.pathname === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className="flex-1 flex flex-col items-center py-3 gap-1 transition-colors"
              style={{ color: active ? '#F59E0B' : '#78716C' }}
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
