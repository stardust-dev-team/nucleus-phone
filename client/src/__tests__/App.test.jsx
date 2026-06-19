/**
 * App-level route-gate contract — bead nucleus-phone-3gr1 (Linus final-review).
 *
 * Pins the load-bearing route gate in App.jsx: in JORUVA mode the /queue
 * route is NOT registered, so a direct URL hit on /queue must fall through
 * to the catch-all <Route path="*"/> and Navigate to /. The Shell.jsx menu-
 * tab swap is a UX nicety; this Route conditional is the actual enforcement.
 *
 * Why this test exists: a refactor that "simplifies" the conditional
 * (e.g., always registering the Route and gating inside Queue) would let a
 * JORUVA-mode user with a stale bookmark to /queue land on a Queue page
 * that immediately fires getQueue against a misconfigured TriStar surface.
 *
 * NOT covered here:
 *   - handleLogout configureApi-with-nulls contract — fully covered (with
 *     ordering invariant) by client/src/__tests__/app-credential-bleed.test.jsx.
 *     Duplication intentionally avoided.
 *   - Server-side TRISTAR_ALLOWED_IDENTITIES gate — server/__tests__/auth.test.js.
 *   - api.js mode-router behavior — client/src/lib/__tests__/mode-router.test.js.
 *
 * Uses real react-router-dom (MemoryRouter) because the test exercises
 * actual Route matching — a fully mocked Route ({element}) => element passes
 * every Route through unconditionally and defeats the assertion. Queue.test.jsx
 * already proves requireActual('react-router-dom') resolves from a
 * sibling-depth __tests__ directory.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import '@testing-library/jest-dom';

/**
 * Probe component that surfaces the current router location as text. Used
 * to assert the actual pathname, not just which component rendered — the
 * positive TRISTAR test would otherwise pass for the wrong reason because
 * `/` ALSO renders Queue in TRISTAR mode (App.jsx:189). A regression that
 * dropped the /queue Route registration would let the catch-all redirect
 * to /, Queue would render anyway, and the test would lie.
 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-pathname">{location.pathname}</div>;
}

const mockConfigureApi = jest.fn();
jest.mock('../lib/api', () => {
  return {
    configureApi: (...args) => mockConfigureApi(...args),
    getModeConfig: () => ({ mode: 'joruva' }),
    apiFetch: jest.fn(() => Promise.resolve({})),
    getToken: jest.fn(),
    getQueue: jest.fn(() => Promise.resolve({ practices: [], sequencer_dry_run_state: 'live', count: 0, tiers: [], limit: 50 })),
    initiateCall: jest.fn(),
    joinCall: jest.fn(),
    muteParticipant: jest.fn(),
    getActiveCalls: jest.fn(() => Promise.resolve({ calls: [] })),
    endCall: jest.fn(),
    searchContacts: jest.fn(() => Promise.resolve({ contacts: [] })),
    getSignalContacts: jest.fn(() => Promise.resolve({ companies: [], total: 0 })),
    getSignalCallbacks: jest.fn(() => Promise.resolve({ callbacks: [] })),
    getContact: jest.fn(),
    getActivity: jest.fn(() => Promise.resolve({ items: [], total: 0 })),
    getCallDetail: jest.fn(),
    getActivityTimeline: jest.fn(),
    saveDisposition: jest.fn(),
    saveTristarDisposition: jest.fn(),
    getCockpit: jest.fn(),
    getNextUncalled: jest.fn(),
    refreshCockpit: jest.fn(),
    getScoreboard: jest.fn(() => Promise.resolve({})),
    startPracticeCall: jest.fn(),
    getPracticeCallStatus: jest.fn(),
    cancelPracticeCall: jest.fn(),
    linkVapiCall: jest.fn(),
    getSimListenUrl: jest.fn(),
    getPracticeScores: jest.fn(() => Promise.resolve({})),
    getPracticeScoreboard: jest.fn(() => Promise.resolve({})),
    runTestScenario: jest.fn(),
    askNucleus: jest.fn(),
    askNucleusEscalate: jest.fn(),
    askNucleusGetConversation: jest.fn(),
    askNucleusListConversations: jest.fn(() => Promise.resolve({ conversations: [] })),
    askNucleusDeleteConversation: jest.fn(),
  };
});

// Shell is the layout route — its <Outlet/> renders the matched child Route.
// Use the REAL Outlet (via requireActual) so the route-tree under Shell
// actually mounts; a stub Shell would never render the matched page.
jest.mock('../components/layout/Shell', () => {
  const { Outlet } = jest.requireActual('react-router-dom');
  return {
    __esModule: true,
    default: () => <div data-testid="shell"><Outlet /></div>,
  };
});
jest.mock('../components/layout/DegradedBanner', () => ({ __esModule: true, default: () => null }));

// Distinct testIds per page so the assertion can tell which Route matched.
jest.mock('../pages/Login', () => ({ __esModule: true, default: () => <div data-testid="login" /> }));
jest.mock('../pages/Contacts', () => ({ __esModule: true, default: () => <div data-testid="contacts" /> }));
jest.mock('../pages/Queue', () => ({ __esModule: true, default: () => <div data-testid="queue" /> }));
jest.mock('../pages/Dialer', () => ({ __esModule: true, default: () => <div data-testid="dialer" /> }));
jest.mock('../pages/CallComplete', () => ({ __esModule: true, default: () => <div data-testid="call-complete" /> }));
jest.mock('../pages/ActiveCalls', () => ({ __esModule: true, default: () => <div data-testid="active-calls" /> }));
jest.mock('../pages/Cockpit', () => ({ __esModule: true, default: () => <div data-testid="cockpit" /> }));
jest.mock('../pages/Scoreboard', () => ({ __esModule: true, default: () => <div data-testid="scoreboard" /> }));
jest.mock('../pages/Activity', () => ({ __esModule: true, default: () => <div data-testid="activity" /> }));
jest.mock('../pages/AskNucleus', () => ({ __esModule: true, default: () => <div data-testid="ask" /> }));
jest.mock('../pages/Debug', () => ({ __esModule: true, default: () => <div data-testid="debug" /> }));

jest.mock('../hooks/useTwilioDevice', () => ({
  __esModule: true,
  default: () => ({ status: 'ready', sendDigits: jest.fn(), toggleMute: jest.fn(), muted: false }),
}));
jest.mock('../hooks/useCallState', () => ({
  __esModule: true,
  default: () => ({}),
}));

import App from '../App';

function mockMe(payload) {
  global.fetch = jest.fn((url) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({ ok: payload !== null, json: () => Promise.resolve(payload) });
    }
    if (url === '/api/auth/email-ready') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ready: true }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('App route gates', () => {
  beforeEach(() => {
    mockConfigureApi.mockReset();
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('JORUVA-mode direct nav to /queue redirects to /', async () => {
    // Joruva /me — no tristar block — so App ends up in MODES.JORUVA.
    // In that mode the /queue Route is NOT registered (App.jsx:207-209),
    // so the catch-all <Route path="*"/> matches and Navigates to /.
    // The / route renders Contacts in JORUVA mode (App.jsx:186-199).
    mockMe({ identity: 'tom', role: 'admin', email: 'tom@joruva.com' });

    render(
      <MemoryRouter initialEntries={['/queue']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    // Auth resolves → mode commits to JORUVA → catch-all matches /queue →
    // Navigate to / → Contacts mounts.
    await waitFor(() => expect(screen.getByTestId('contacts')).toBeInTheDocument());

    // Queue must NOT have rendered. If the route gate regresses (e.g., the
    // mode === TRISTAR conditional gets dropped from the Route declaration),
    // /queue would match the real Route and Queue would mount here.
    expect(screen.queryByTestId('queue')).not.toBeInTheDocument();
    // Pathname confirms the redirect actually fired (vs. the matched-
    // component check, which could in principle pass for other reasons).
    expect(screen.getByTestId('location-pathname').textContent).toBe('/');
  });

  it('TRISTAR-mode direct nav to /queue renders Queue', async () => {
    // Counter-test: when mode IS TriStar, the gate must let /queue through.
    // Without this, a false-positive could pass the negative test by
    // breaking the route registration in BOTH modes.
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: { configured: true },
    });

    render(
      <MemoryRouter initialEntries={['/queue']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('queue')).toBeInTheDocument());
    expect(screen.queryByTestId('contacts')).not.toBeInTheDocument();
    // Critical: the pathname must STAY at /queue. If the /queue Route
    // registration regressed in TRISTAR mode, the catch-all would
    // redirect to / and Queue would render anyway (because `/` renders
    // Queue in TRISTAR mode too — App.jsx:189). Without this assertion
    // the positive test would lie green.
    expect(screen.getByTestId('location-pathname').textContent).toBe('/queue');
  });
});
