import { useState, useEffect, Component } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Shell from './components/layout/Shell';
import Login from './pages/Login';
import Contacts from './pages/Contacts';
import Dialer from './pages/Dialer';
import CallComplete from './pages/CallComplete';
import ActiveCalls from './pages/ActiveCalls';
import Cockpit from './pages/Cockpit';
import Scoreboard from './pages/Scoreboard';
import Activity from './pages/Activity';
import AskNucleus from './pages/AskNucleus';
import Debug from './pages/Debug';
import Queue from './pages/Queue';
import useTwilioDevice from './hooks/useTwilioDevice';
import useCallState from './hooks/useCallState';
import { configureApi } from './lib/api';
import { MODES } from './lib/mode-router';
import DegradedBanner from './components/layout/DegradedBanner';

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
          <h1 className="text-xl font-semibold text-aunshin-peach-light">Something went wrong</h1>
          <p className="text-aunshin-quiet-d text-sm max-w-md text-center">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            className="px-4 py-2 bg-aunshin-sodium text-white rounded hover:opacity-90"
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
  const [mode, setMode] = useState(MODES.JORUVA); // mirrors api.js config for UI gating (queue link, /queue route)
  const [loading, setLoading] = useState(true);
  const [emailReady, setEmailReady] = useState(null); // null = loading, true = tokens exist, false = re-login needed

  // Check session on mount. The /me response carries a tristar block iff the
  // user is on TRISTAR_ALLOWED_IDENTITIES (server/routes/auth.js). Post-stet
  // that block is just { configured }: the API key never reaches the browser
  // (the /api/tristar/* server proxy injects it). We enter TriStar mode only
  // when configured === true; allowlisted-but-not-configured stays in Joruva
  // mode and raises the DegradedBanner so the server misconfig is visible.
  //
  // configureApi MUST run before any other hook fires an API call; that's why
  // it's inside this effect's .then, not a separate [user]-dep effect — hooks
  // like useTwilioDevice read from api.js the moment user is non-null. We also
  // mirror the mode into React state to gate TriStar-only UI; the api.js
  // module config stays authoritative for FETCH, and both are set from the
  // same callback so they cannot drift.
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const { tristar, ...userFields } = data;
        if (tristar && tristar.configured) {
          configureApi({ mode: MODES.TRISTAR });
          setMode(MODES.TRISTAR);
        } else {
          // Joruva mode. No key is ever held client-side post-stet, so there's
          // nothing to scrub here — the shared-iPad credential-bleed concern
          // that motivated the old NULL-out is gone with the key.
          configureApi({ mode: MODES.JORUVA });
          setMode(MODES.JORUVA);
          // Allowlisted but the server lacks TRISTAR_API_BASE_URL/KEY: surface
          // the misconfig so it's not silently swallowed (the proxy would 503).
          if (tristar && !tristar.configured && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('api:degraded', {
              detail: { reason: 'tristar-unconfigured', timestamp: Date.now() },
            }));
          }
        }
        setUser(userFields);
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
    // Reset to Joruva mode before the network round-trip so a fast next-login
    // can't briefly inherit TriStar mode. Post-stet there's no client-side key
    // to scrub — mode is the only state.
    configureApi({ mode: MODES.JORUVA });
    setMode(MODES.JORUVA);
    // .finally — if the /logout POST rejects (flaky network), creds are
    // already wiped client-side; we still need to drop the UI to Login
    // or the user is stranded in a half-logged-out state.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .catch(() => {})
      .finally(() => setUser(null));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-aunshin-quiet-d">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <>
      {/* TriStar mode degraded-config banner (bead nucleus-phone-gxt2).
        * Mounted at App level so it sits above BOTH the Cockpit route
        * (which renders without Shell) and the Shell-wrapped routes.
        * The banner is its own listener; no prop wiring required. */}
      <DegradedBanner />
      <Routes>
        {/* Real cockpit renders WITHOUT Shell (full-screen focus) */}
        <Route
          path="/cockpit/:id"
          element={
            <Cockpit
              identity={identity}
              role={role}
              callState={callState}
              twilioStatus={twilioHook.status}
              onSendDigits={twilioHook.sendDigits}
              onToggleMute={twilioHook.toggleMute}
              muted={twilioHook.muted}
            />
          }
        />

        {/* Everything else renders inside Shell layout route */}
        <Route element={<Shell identity={identity} role={role} mode={mode} onLogout={handleLogout} deviceStatus={twilioHook.status} emailReady={emailReady} />}>
          {/* `/` is mode-branched so back-nav from Cockpit (handleBack →
            * navigate('/')) and the catch-all `*` redirect both land the
            * user on their correct landing surface. Without this, a
            * TriStar user tapping wrong-row → Cockpit → back gets dumped
            * on a Joruva-mode Contacts page with no obvious recovery.
            * */}
          <Route
            path="/"
            element={
              mode === MODES.TRISTAR
                ? <Queue />
                : (
                  <Contacts
                    identity={identity}
                    callState={callState}
                    twilioStatus={twilioHook.status}
                  />
                )
            }
          />
          {/* TriStar-only routed surface (bead nucleus-phone-e91e). The
            * /queue path resolves to nucleus-tristar via mode-router. The
            * Route conditional below is the load-bearing gate: when mode
            * is JORUVA the Route is not registered, so direct URL access
            * to /queue falls through to the catch-all <Route path="*"/>
            * below and redirects to /. The menu-tab swap in Shell.jsx
            * is a UX nicety, not the enforcement. */}
          {mode === MODES.TRISTAR && (
            <Route path="/queue" element={<Queue />} />
          )}
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
          {role === 'admin' && (
            <Route path="/debug" element={<Debug />} />
          )}
          <Route path="/activity" element={<Activity identity={identity} role={role} emailReady={emailReady} />} />
          <Route path="/history" element={<Navigate to="/activity" replace />} />
          <Route path="/summaries" element={<Navigate to="/activity" replace />} />
          <Route path="/ask" element={<AskNucleus />} />
          <Route path="/scoreboard" element={<Scoreboard />} />
          <Route
            path="/practice"
            element={
              <Cockpit
                identity={identity}
                role={role}
                callState={callState}
                twilioStatus={twilioHook.status}
                forcedId="sim-mike-garza"
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}
