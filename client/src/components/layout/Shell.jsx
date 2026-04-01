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
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-jv-border bg-jv-card">
        <div className="flex items-center gap-3">
          <img
            src="https://joruva.com/wp-content/uploads/2024/10/joruva-logo-white.svg"
            alt="Joruva"
            className="h-6"
          />
          <span className="text-sm text-jv-muted">Phone</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${STATUS_COLORS[deviceStatus] || 'bg-gray-500'}`} />
            <span className="text-sm capitalize">{identity}</span>
          </div>
          <button
            onClick={onLogout}
            className="text-xs text-jv-muted hover:text-white transition-colors"
          >
            Logout
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto scroll-container">
        <Outlet />
      </main>

      {/* Bottom nav */}
      <nav className="flex border-t border-jv-border bg-jv-card pb-[env(safe-area-inset-bottom)]">
        {tabs.map((tab) => {
          const active = location.pathname === tab.path;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className={`flex-1 flex flex-col items-center py-3 gap-1 transition-colors ${
                active ? 'text-jv-blue' : 'text-jv-muted'
              }`}
            >
              <span className="text-lg">{tab.icon}</span>
              <span className="text-xs">{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
