/**
 * App credential-bleed contract — bead nucleus-phone-e91e (Linus pass-3 P1).
 *
 * Pins the client-side defense against the shared-iPad credential-bleed bug
 * that pass-3 found and 19c76de fixed.
 *
 * Background: `client/src/lib/api.js` keeps a module-level `_modeConfig`
 * singleton that `configureApi(next)` mutates via `{..._modeConfig, ...next}`.
 * If the JORUVA-mode call site OMITS `tristarBaseUrl`/`tristarApiKey` (e.g.,
 * `configureApi({mode: JORUVA})`), the spread leaves a prior TriStar
 * session's credentials resident in module memory. On a shared iPad: Britt
 * logs out, Tom logs in as JORUVA, his React tree could read Britt's
 * tristarApiKey via `getModeConfig()`.
 *
 * This test asserts the THREE write sites in App.jsx (Joruva /me path,
 * handleLogout, TriStar /me path) all pass the FULL field set. A refactor
 * that drops the explicit nulls (or stops setting them in handleLogout
 * BEFORE the network round-trip) will fail this test loudly — closing the
 * call-site discipline gap that the singleton pattern leaves wide open.
 *
 * Test location: client/src/__tests__/ (alongside the code it exercises).
 * Initially placed at the project root __tests__/, but react-router-dom is
 * installed under client/node_modules and not resolvable from the root —
 * jest.mock requires the module to resolve to a real path. The mock factory
 * itself doesn't need the real module; jest's resolver does. Lives here so
 * the resolver finds the package.
 *
 * NOT covered here:
 *   - The server-side /me response shape (covered by server/__tests__/
 *     auth.test.js and the TRISTAR_ALLOWED_IDENTITIES env contract).
 *   - The api.js apiFetch routing behavior (covered by api.test.js and
 *     mode-router.test.js).
 *   - The structural fix (resetApi() helper or React-context migration)
 *     that would replace the discipline-based defense — tracked separately.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock api.js so we can spy on configureApi without it actually mutating
// a real module singleton. The class exports are preserved for any
// component code that does instanceof checks; we only care about the
// configureApi call args here.
const mockConfigureApi = jest.fn();
const mockGetModeConfig = jest.fn(() => ({ mode: 'joruva', tristarBaseUrl: null, tristarApiKey: null }));
jest.mock('../lib/api', () => {
  class ApiDegradedError extends Error {
    constructor(path) { super(`degraded: ${path}`); this.name = 'ApiDegradedError'; this.path = path; }
  }
  return {
    configureApi: (...args) => mockConfigureApi(...args),
    getModeConfig: (...args) => mockGetModeConfig(...args),
    ApiDegradedError,
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
    mockGetModeConfig.mockReset().mockReturnValue({ mode: 'joruva', tristarBaseUrl: null, tristarApiKey: null });
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('JORUVA-mode /me MUST call configureApi with explicit nulls for tristarBaseUrl + tristarApiKey', async () => {
    mockMe({ identity: 'tom', role: 'admin', email: 'tom@joruva.com' });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalled());

    // The defensive contract: a Joruva-mode /me payload (no tristar block)
    // MUST overwrite tristarBaseUrl + tristarApiKey with null, not omit
    // them. Omission would leave a prior TriStar session's creds in
    // module memory under the spread semantics of api.js:configureApi.
    expect(mockConfigureApi).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'joruva',
        tristarBaseUrl: null,
        tristarApiKey: null,
      })
    );
  });

  it('TriStar-mode /me MUST call configureApi with the credential triple from the response', async () => {
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: {
        baseUrl: 'https://nucleus-tristar.onrender.com',
        apiKey: 'test-api-key-britt',
      },
    });

    render(<App />);

    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalled());

    expect(mockConfigureApi).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'tristar',
        tristarBaseUrl: 'https://nucleus-tristar.onrender.com',
        tristarApiKey: 'test-api-key-britt',
      })
    );
  });

  it('handleLogout MUST clear TriStar creds via configureApi BEFORE the /logout network round-trip', async () => {
    // Start as TriStar so handleLogout has something to clear.
    mockMe({
      identity: 'britt',
      role: 'caller',
      email: 'britt@joruva.com',
      tristar: { baseUrl: 'https://nucleus-tristar.onrender.com', apiKey: 'test-api-key-britt' },
    });

    render(<App />);

    // Wait for the boot configureApi to land so we can isolate the
    // logout-driven call.
    await waitFor(() => expect(mockConfigureApi).toHaveBeenCalledTimes(1));

    // Capture the logout-fetch invocation order vs the configureApi call.
    // The contract is: configureApi(null creds) runs BEFORE fetch fires.
    // A regression that swapped them would let a fast next-user /me race
    // see Britt's creds in the singleton during the logout window.
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
      // The clearing configureApi must have ticked BEFORE the logout fetch.
      expect(apiCallTimestamps[0]).toBeLessThan(logoutFetch.t);
    });

    // The clearing call must pass explicit nulls — not just the mode flip.
    expect(mockConfigureApi).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'joruva',
        tristarBaseUrl: null,
        tristarApiKey: null,
      })
    );
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
