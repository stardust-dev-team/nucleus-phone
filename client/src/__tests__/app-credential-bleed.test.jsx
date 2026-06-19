/**
 * App credential-bleed contract — bead nucleus-phone-e91e; reworked by
 * nucleus-phone-stet (P1).
 *
 * Pre-stet this pinned a discipline-based defense: App.jsx had to pass explicit
 * null tristarBaseUrl/tristarApiKey on the Joruva + logout paths so a prior
 * TriStar session's key wouldn't linger in the api.js module singleton on a
 * shared iPad.
 *
 * Post-stet that whole failure mode is DESIGNED OUT: the TRISTAR_API_KEY never
 * reaches the browser. /me returns only `tristar: { configured }`, App.jsx
 * configures api.js with `mode` alone, and the same-origin /api/tristar/* proxy
 * injects the key server-side. So the contract this test now pins is the
 * stronger one: App.jsx NEVER passes a TriStar key/base-url into configureApi —
 * there is no credential to bleed.
 *
 * Asserts the three configureApi write sites in App.jsx (Joruva /me, TriStar
 * /me, handleLogout) and that none of them carries a key/base-url field.
 *
 * Test location: client/src/__tests__/ (react-router-dom resolves under
 * client/node_modules; jest.mock needs the package to resolve from here).
 *
 * NOT covered here: the server /me response shape (server proxy tests) and the
 * api.js routing behavior (api.test.js + tristar-mode-no-local-writes).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock api.js so we can spy on configureApi without it actually mutating
// a real module singleton. The class exports are preserved for any
// component code that does instanceof checks; we only care about the
// configureApi call args here.
const mockConfigureApi = jest.fn();
const mockGetModeConfig = jest.fn(() => ({ mode: 'joruva' }));
jest.mock('../lib/api', () => {
  return {
    configureApi: (...args) => mockConfigureApi(...args),
    getModeConfig: (...args) => mockGetModeConfig(...args),
    apiFetch: jest.fn(() => Promise.resolve({})),
    // The page components mocked below don't actually call these, but jest
    // requires every named export the importer uses to be present in the
    // mock. Add stubs as new imports surface.
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

// Mock react-router-dom — the dep is installed under client/node_modules,
// not the project root, so jest.requireActual fails from this test file's
// location. Provide just enough surface for App.jsx to render: Routes
// passes children through, Route is a no-op wrapper, Navigate is a no-op.
// We don't care about route fidelity — configureApi calls happen in the
// /me effect before any route renders, and handleLogout is reached via
// the Shell mock's logout button.
jest.mock('react-router-dom', () => ({
  Routes: ({ children }) => <>{children}</>,
  Route: ({ element }) => element || null,
  Navigate: () => null,
  useNavigate: () => jest.fn(),
  useLocation: () => ({ pathname: '/' }),
  Outlet: () => null,
}));

// Mock every page component so their own data-fetching effects don't fire
// and pollute the test. We only care about App.jsx's auth-effect behavior.
const pageMock = ({ children } = {}) => <div data-testid="page-mock">{children || null}</div>;
jest.mock('../components/layout/Shell', () => ({
  __esModule: true,
  default: ({ onLogout }) => (
    <div data-testid="shell">
      <button type="button" onClick={onLogout} aria-label="Logout">Logout</button>
    </div>
  ),
}));
jest.mock('../components/layout/DegradedBanner', () => ({ __esModule: true, default: () => null }));
jest.mock('../pages/Login', () => ({ __esModule: true, default: () => <div data-testid="login" /> }));
jest.mock('../pages/Contacts', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Dialer', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/CallComplete', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/ActiveCalls', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Cockpit', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Scoreboard', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Activity', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/AskNucleus', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Debug', () => ({ __esModule: true, default: pageMock }));
jest.mock('../pages/Queue', () => ({ __esModule: true, default: pageMock }));

// Hooks that fire side effects (Twilio device init, etc.) get neutered.
jest.mock('../hooks/useTwilioDevice', () => ({
  __esModule: true,
  default: () => ({ status: 'ready', sendDigits: jest.fn(), toggleMute: jest.fn(), muted: false }),
}));
jest.mock('../hooks/useCallState', () => ({
  __esModule: true,
  default: () => ({}),
}));

import App from '../App';

// Test helpers for mocking the /me + /email-ready fetches.
function mockMe(payload) {
  global.fetch = jest.fn((url) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({ ok: payload !== null, json: () => Promise.resolve(payload) });
    }
    if (url === '/api/auth/email-ready') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ready: true }) });
    }
    if (url === '/api/auth/logout') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('App credential-bleed contract', () => {
  beforeEach(() => {
    mockConfigureApi.mockReset();
    mockGetModeConfig.mockReset().mockReturnValue({ mode: 'joruva' });
  });

  afterEach(() => {
    delete global.fetch;
  });

  // The post-stet invariant: configureApi must NEVER be handed a TriStar key or
  // base URL — the browser holds neither. Any object carrying these fields is a
  // regression toward the old client-side-key model.
  function expectNoCredFields(call) {
    const arg = call[0] || {};
    expect(arg).not.toHaveProperty('tristarApiKey');
    expect(arg).not.toHaveProperty('tristarBaseUrl');
    expect(arg).not.toHaveProperty('apiKey');
  }

  it('JORUVA-mode /me configures api.js with mode only (no key/base-url fields)', async () => {
    mockMe({ identity: 'tom', role: 'admin', email: 'tom@joruva.com' });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalled());

    expect(mockConfigureApi).toHaveBeenCalledWith({ mode: 'joruva' });
    mockConfigureApi.mock.calls.forEach(expectNoCredFields);
  });

  it('TriStar-mode /me (configured:true) configures api.js with mode only — NO key reaches the client', async () => {
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: { configured: true },
    });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalled());

    expect(mockConfigureApi).toHaveBeenCalledWith({ mode: 'tristar' });
    mockConfigureApi.mock.calls.forEach(expectNoCredFields);
  });

  it('allowlisted-but-not-configured /me stays in Joruva mode (no key, proxy 503 would surface)', async () => {
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: { configured: false },
    });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalled());

    expect(mockConfigureApi).toHaveBeenCalledWith({ mode: 'joruva' });
    mockConfigureApi.mock.calls.forEach(expectNoCredFields);
  });

  it('handleLogout resets to Joruva mode BEFORE the /logout round-trip (no creds to clear)', async () => {
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: { configured: true },
    });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalledTimes(1));

    // Ordering still matters: mode must flip to Joruva before the network call
    // so a fast next-login can't briefly inherit TriStar mode.
    const fetchCallTimestamps = [];
    const apiCallTimestamps = [];
    let tick = 0;

    mockConfigureApi.mockImplementation(() => { apiCallTimestamps.push(++tick); });
    global.fetch = jest.fn((url) => {
      fetchCallTimestamps.push({ url, t: ++tick });
      if (url === '/api/auth/logout') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(null) });
    });

    fireEvent.click(await screen.findByRole('button', { name: /Logout/i }));

    await waitFor(() => {
      const logoutFetch = fetchCallTimestamps.find((f) => f.url === '/api/auth/logout');
      expect(logoutFetch).toBeDefined();
      expect(apiCallTimestamps.length).toBeGreaterThanOrEqual(1);
      expect(apiCallTimestamps[0]).toBeLessThan(logoutFetch.t);
    });

    expect(mockConfigureApi).toHaveBeenCalledWith({ mode: 'joruva' });
  });

  it('null /me response does NOT call configureApi (no boot, no clear)', async () => {
    // /me returns null (unauthenticated). The auth effect short-circuits
    // before reaching either branch — no configureApi call. Login renders.
    mockMe(null);

    render(<App />);

    // Give the effect a chance to fire. The .then short-circuits on null.
    await waitFor(() => expect(screen.getByTestId('login')).toBeInTheDocument());

    expect(mockConfigureApi).not.toHaveBeenCalled();
  });
});
