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

  // Check session on mount. If the /me response carries a tristar block
  // (server gates by TRISTAR_ALLOWED_IDENTITIES — see server/routes/auth.js),
  // flip api.js into TriStar mode. configureApi MUST run before any other
  // hook fires an API call; that's why it's inside this effect's .then,
  // not a separate effect with [user] dep — hooks like useTwilioDevice
  // read from api.js the moment user is non-null.
  //
  // We also mirror the mode into React state so Shell and App can gate
  // the TriStar-only UI (queue menu link, /queue route). The api.js
  // module-level config remains authoritative for what FETCH does; the
  // React mirror is purely for rendering. Drift between the two is
  // impossible by construction — both are set in the same callback from
  // the same source of truth.
  useEffect(() => {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const { tristar, ...userFields } = data;
        if (tristar) {
          configureApi({
            mode: MODES.TRISTAR,
            tristarBaseUrl: tristar.baseUrl,
            tristarApiKey: tristar.apiKey,
          });
          setMode(MODES.TRISTAR);
        } else {
          // Belt-and-suspenders: NULL out tristarBaseUrl/tristarApiKey on
          // the Joruva path. configureApi uses object spread (api.js:49)
          // so omitting these would leave any prior TriStar-session key
          // resident in module memory. Critical on a shared iPad where
          // Britt logs out and Tom logs in.
          configureApi({
            mode: MODES.JORUVA,
            tristarBaseUrl: null,
            tristarApiKey: null,
          });
          setMode(MODES.JORUVA);
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
    // Clear TriStar credentials from module-level config BEFORE the
    // network round-trip — protects against state-bleed if the next user
    // logs in fast and the second /me response races the first. Without
    // this, a JORUVA-mode next-user could have a prior session's
    // TRISTAR_API_KEY in module memory until their /me result lands.
    configureApi({
      mode: MODES.JORUVA,
      tristarBaseUrl: null,
      tristarApiKey: null,
    });
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
