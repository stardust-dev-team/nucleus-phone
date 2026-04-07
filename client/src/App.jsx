import { useState, useEffect, Component } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/layout/Shell';
import Login from './pages/Login';
import Contacts from './pages/Contacts';
import Dialer from './pages/Dialer';
import CallComplete from './pages/CallComplete';
import ActiveCalls from './pages/ActiveCalls';
import History from './pages/History';
import Cockpit from './pages/Cockpit';
import Scoreboard from './pages/Scoreboard';
import useTwilioDevice from './hooks/useTwilioDevice';
import useCallState from './hooks/useCallState';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('Nucleus Phone uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
          <h1 className="text-xl font-semibold text-jv-text">Something went wrong</h1>
          <p className="text-jv-muted text-sm max-w-md text-center">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            className="px-4 py-2 bg-jv-accent text-white rounded hover:opacity-90"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppContent() {
  const [user, setUser] = useState(null); // { identity, role, email }
  const [loading, setLoading] = useState(true);
  const [emailReady, setEmailReady] = useState(null); // null = loading, true = tokens exist, false = re-login needed

  // Check session on mount
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setUser(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Check if rep has MSAL tokens for email sending
  useEffect(() => {
    if (!user) return;
    fetch('/api/auth/email-ready', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setEmailReady(data.ready); })
      .catch(() => {});
  }, [user]);

  const identity = user?.identity || '';
  const role = user?.role || 'caller';

  const twilioHook = useTwilioDevice(user ? identity : null);
  const callState = useCallState(twilioHook);

  function handleLogout() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .then(() => {
        setUser(null);
      });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-jv-muted">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <Routes>
      {/* Real cockpit renders WITHOUT Shell (full-screen focus) */}
      <Route
        path="/cockpit/:id"
        element={
          <Cockpit
            identity={identity}
            callState={callState}
            twilioStatus={twilioHook.status}
            onSendDigits={twilioHook.sendDigits}
            onToggleMute={twilioHook.toggleMute}
            muted={twilioHook.muted}
          />
        }
      />

      {/* Everything else renders inside Shell layout route */}
      <Route element={<Shell identity={identity} role={role} onLogout={handleLogout} deviceStatus={twilioHook.status} emailReady={emailReady} />}>
        <Route
          path="/"
          element={
            <Contacts
              identity={identity}
              callState={callState}
              twilioStatus={twilioHook.status}
            />
          }
        />
        <Route
          path="/dialer"
          element={
            <Dialer
              identity={identity}
              twilioHook={twilioHook}
              callState={callState}
            />
          }
        />
        <Route
          path="/complete"
          element={
            <CallComplete
              callState={callState}
              identity={identity}
              emailReady={emailReady}
            />
          }
        />
        {role === 'admin' && (
          <Route
            path="/active"
            element={
              <ActiveCalls
                identity={identity}
                callState={callState}
                twilioHook={twilioHook}
              />
            }
          />
        )}
        <Route path="/history" element={<History identity={identity} role={role} />} />
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route
          path="/practice"
          element={
            <Cockpit
              identity={identity}
              callState={callState}
              twilioStatus={twilioHook.status}
              forcedId="sim-mike-garza"
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
