import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/layout/Shell';
import Login from './pages/Login';
import Contacts from './pages/Contacts';
import Dialer from './pages/Dialer';
import CallComplete from './pages/CallComplete';
import ActiveCalls from './pages/ActiveCalls';
import History from './pages/History';
import useTwilioDevice from './hooks/useTwilioDevice';
import useCallState from './hooks/useCallState';

const ROLES = {
  tom: 'admin',
  paul: 'admin',
  kate: 'caller',
  britt: 'caller',
  ryann: 'caller',
  alex: 'caller',
};

export default function App() {
  const [identity, setIdentity] = useState(() => localStorage.getItem('nucleus_identity') || '');
  const [authenticated, setAuthenticated] = useState(() => !!localStorage.getItem('nucleus_api_key'));

  const role = ROLES[identity] || 'caller';
  const twilioHook = useTwilioDevice(authenticated ? identity : null);
  const callState = useCallState(twilioHook);

  function handleLogin(name, apiKey) {
    localStorage.setItem('nucleus_identity', name);
    localStorage.setItem('nucleus_api_key', apiKey);
    setIdentity(name);
    setAuthenticated(true);
  }

  function handleLogout() {
    localStorage.removeItem('nucleus_identity');
    localStorage.removeItem('nucleus_api_key');
    setIdentity('');
    setAuthenticated(false);
  }

  if (!authenticated) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Shell identity={identity} role={role} onLogout={handleLogout} deviceStatus={twilioHook.status}>
      <Routes>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
