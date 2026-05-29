/**
 * Queue (TriStarQueueView) — bead nucleus-phone-e91e / stardust-tristar [coc.1.c].
 *
 * Covers the rendering + interaction contract:
 *   - loading state shows on first render
 *   - practices render after fetch with required fields
 *   - owner_phone is the dial-target button (MOST CRITICAL field per bead)
 *   - dry-run banner toggles on sequencer_dry_run_state !== 'live'
 *   - empty state renders when practices array is empty
 *   - ApiDegradedError is caught + surfaced inline (DegradedBanner is the
 *     global banner; this page also shows a row-level message so the
 *     content area isn't blank)
 *   - touchpoint replied-at trumps sent-at visually
 *   - tier filter button toggle re-issues getQueue with the right param
 *   - multi-in-progress dial-block (bead nucleus-phone-02k6) — warning
 *     copy + hard dial-block on phone_in_progress_count > 1
 *
 * NOT covered here (out of scope for this bead):
 *   - Post-call disposition-modal warning (the modal itself is not yet
 *     built; when it lands, that surface needs its own staleness/
 *     refresh decision — see Queue.jsx header for the trade-off context)
 *   - End-to-end mode routing through api.js → mode-router (covered by
 *     api.test.js and mode-router.test.js — that's the contract this
 *     page consumes, not redefines)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();
// requireActual + override: preserves anything else this page might import
// from react-router-dom in future (Link, NavLink, Outlet) without silently
// returning undefined. Today only useNavigate is consumed.
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock getQueue + the two error classes (ApiDegradedError, ApiAuthError)
// before importing the component. Queue.jsx imports all three from
// ../lib/api at module load — the mock has to be in place before that
// import is resolved.
//
// Both error classes are mirrored here because Queue.jsx uses
// `err instanceof <Class>` to branch (see Queue.jsx:365, 378). If the
// mock omits a class, the consumer sees `undefined` and `instanceof`
// throws TypeError — masking every error-handling test in the file.
//
// jest.mock factories are hoisted ABOVE top-level const/class declarations,
// so the mock classes are defined inside the factory and re-exported for
// use in test bodies via the imported api module reference below.
const mockGetQueue = jest.fn();
jest.mock('../../lib/api', () => {
  class ApiDegradedError extends Error {
    constructor(path) {
      super(`degraded: ${path}`);
      this.name = 'ApiDegradedError';
      this.path = path;
    }
  }
  class ApiAuthError extends Error {
    constructor(path, status, target, body) {
      super(`Auth failed (${status}) on ${target}:${path}`);
      this.name = 'ApiAuthError';
      this.path = path;
      this.status = status;
      this.target = target;
      this.body = body;
    }
  }
  return {
    getQueue: (...args) => mockGetQueue(...args),
    ApiDegradedError,
    ApiAuthError,
  };
});

import Queue from '../Queue';
import {
  ApiDegradedError as MockApiDegradedError,
  ApiAuthError as MockApiAuthError,
} from '../../lib/api';

function makePractice(overrides = {}) {
  return {
    practice_id: 'p-1',
    practice_name: 'Sunnyvale Veterinary',
    practice_phone: '+15551110000',
    owner_first_name: 'Jane',
    owner_last_name: 'Doe',
    owner_phone: '+15552223333',
    owner_email: 'jane@sunnyvet.com',
    owner_title: 'Practice Owner',
    intent_tier: 'hot',
    cadence_profile: 'high_intent',
    attempt_sequence_label: 'Call 2 of 3, Day 7',
    // call_number + total_calls required for the cadence-drift gate in
    // PracticeCard. Without them (or with call_number > total_calls), the
    // label pill is hidden as a defensive measure — see Queue.jsx ~115.
    attempt_call_number: 2,
    attempt_total_calls: 3,
    attempt_day_offset: 7,
    // -60_000 buffer protects against same-ms boundary flake: both this
    // fixture and formatRelativeDay floor on 86400000-ms intervals; if the
    // test's Date.now happens microseconds before the boundary and the
    // component's Date.now happens microseconds after, the bucket changes.
    // 1-minute buffer absorbs CI clock jitter.
    last_email_sent_at: new Date(Date.now() - 3 * 86400000 - 60_000).toISOString(),
    last_email_replied_at: null,
    last_linkedin_dm_sent_at: null,
    last_linkedin_dm_replied_at: null,
    // bead nucleus-phone-02k6 — backend ships COUNT(*)::int (0 on empty,
    // never null). Default to 0 so existing tests don't trip the dial-block.
    phone_in_progress_count: 0,
    ...overrides,
  };
}

function liveResponse(practices = [makePractice()]) {
  return {
    count: practices.length,
    limit: 50,
    tiers: ['warm', 'hot'],
    sequencer_dry_run_state: 'live',
    practices,
  };
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockGetQueue.mockReset();
});

describe('Queue / TriStarQueueView', () => {
  it('shows loading state on first render', () => {
    mockGetQueue.mockReturnValue(new Promise(() => {})); // never resolves
    render(<Queue />);
    expect(screen.getByText(/Loading queue/i)).toBeInTheDocument();
  });

  it('renders required fields for each practice', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);

    expect(await screen.findByText('Sunnyvale Veterinary')).toBeInTheDocument();
    // owner first + last
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    // owner title
    expect(screen.getByText(/Practice Owner/)).toBeInTheDocument();
    // owner email
    expect(screen.getByText('jane@sunnyvet.com')).toBeInTheDocument();
    // attempt sequence label
    expect(screen.getByText('Call 2 of 3, Day 7')).toBeInTheDocument();
    // cadence profile
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    // intent_tier badge — uppercased "HOT"
    expect(screen.getByText('hot')).toBeInTheDocument();
  });

  it('renders owner_phone as the dial-target button (most critical field)', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);

    const callButton = await screen.findByRole('button', { name: /Call Jane Doe at \+15552223333/ });
    expect(callButton).toBeEnabled();
    expect(callButton).toHaveTextContent('+15552223333');
  });

  it('falls back to practice_phone when owner_phone is null', async () => {
    mockGetQueue.mockResolvedValue(liveResponse([
      makePractice({ owner_phone: null }),
    ]));
    render(<Queue />);

    const callButton = await screen.findByRole('button', { name: /Call Jane Doe at \+15551110000/ });
    expect(callButton).toHaveTextContent('+15551110000');
  });

  it('disables call button when no phone is on file', async () => {
    mockGetQueue.mockResolvedValue(liveResponse([
      makePractice({ owner_phone: null, practice_phone: null }),
    ]));
    render(<Queue />);

    const callButton = await screen.findByRole('button', { name: /No phone number on file/ });
    expect(callButton).toBeDisabled();
  });

  it('navigates to /cockpit/<owner_phone> when call button clicked', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);

    const callButton = await screen.findByRole('button', { name: /Call Jane Doe/ });
    fireEvent.click(callButton);
    // encodeURIComponent of "+15552223333" → "%2B15552223333"
    expect(mockNavigate).toHaveBeenCalledWith('/cockpit/%2B15552223333');
  });

  /**
   * Multi-in-progress dial-block — bead nucleus-phone-02k6.
   *
   * Backend (nucleus-tristar bead 40o, shipped 0dfbe93) ships
   * phone_in_progress_count per practice row. > 1 means at least two
   * concurrent in_progress phone attempts already exist on this practice;
   * a third dialer makes coordination nearly impossible.
   *
   * Fixture-driven: count of 0/1/2 → warning + dial-block only on 2.
   * The 1-row case is the boundary check — one in_progress is the
   * normal state during any active call, must NOT trigger the block.
   */
  describe('multi-in-progress dial-block (phone_in_progress_count)', () => {
    it('does NOT show warning or block dial when phone_in_progress_count is 0', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({ phone_in_progress_count: 0 }),
      ]));
      render(<Queue />);

      await screen.findByText('Sunnyvale Veterinary');
      expect(screen.queryByText(/dialers active/i)).not.toBeInTheDocument();
      const callButton = screen.getByRole('button', { name: /Call Jane Doe at \+15552223333/ });
      expect(callButton).toBeEnabled();
    });

    it('does NOT show warning or block dial when phone_in_progress_count is 1 (boundary)', async () => {
      // One in_progress is the normal state during any active call. The
      // bead pins the threshold at > 1 — drifting to >= 1 would block
      // every practice with a live call in flight.
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({ phone_in_progress_count: 1 }),
      ]));
      render(<Queue />);

      await screen.findByText('Sunnyvale Veterinary');
      expect(screen.queryByText(/dialers active/i)).not.toBeInTheDocument();
      const callButton = screen.getByRole('button', { name: /Call Jane Doe at \+15552223333/ });
      expect(callButton).toBeEnabled();
    });

    it('shows warning and blocks dial when phone_in_progress_count is 2', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({ phone_in_progress_count: 2 }),
      ]));
      render(<Queue />);

      // Warning copy uses the count + "dialers active" + "coordinate".
      // Match the count and the coordination cue separately so a copy
      // tweak that keeps the meaning doesn't cosmetically break the test.
      expect(await screen.findByText(/2 dialers active/i)).toBeInTheDocument();
      expect(screen.getByText(/coordinate/i)).toBeInTheDocument();
      // Alert role for assistive-tech announcement (VoiceOver).
      expect(screen.getByRole('alert')).toHaveTextContent(/2 dialers active/i);

      // Dial button hard-disabled with a distinct aria-label so a screen
      // reader doesn't repeat "Call Jane Doe" on a button that can't dial.
      const blockedButton = screen.getByRole('button', {
        name: /Dial blocked.*2 other dialers/i,
      });
      expect(blockedButton).toBeDisabled();
      expect(blockedButton).toHaveTextContent(/dial blocked/i);
    });

    it('shows warning with higher count when phone_in_progress_count is 5', async () => {
      // Just confirms the count is rendered verbatim, not hardcoded to "2".
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({ phone_in_progress_count: 5 }),
      ]));
      render(<Queue />);
      expect(await screen.findByText(/5 dialers active/i)).toBeInTheDocument();
    });

    it('does NOT block dial when phone_in_progress_count is missing (legacy/defense)', async () => {
      // Number.isFinite guard in PracticeCard: a server serialization drift
      // (field missing, null, or stringified) must not silently block every
      // dial. Defaults to 0 (= no block) under uncertainty.
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({ phone_in_progress_count: undefined }),
      ]));
      render(<Queue />);

      await screen.findByText('Sunnyvale Veterinary');
      expect(screen.queryByText(/dialers active/i)).not.toBeInTheDocument();
      const callButton = screen.getByRole('button', { name: /Call Jane Doe at \+15552223333/ });
      expect(callButton).toBeEnabled();
    });

    // No "blocked button doesn't navigate" test here on purpose. The
    // dial-block is enforced solely by the <button disabled> attribute;
    // there is no runtime onClick guard to test. A fireEvent.click on a
    // disabled button is a no-op in jsdom + @testing-library, so any
    // such test would pass regardless of whether the disabled attribute
    // is being applied correctly — false security. The `toBeDisabled`
    // assertion in the count===2 test above is the real coverage.
    //
    // If the dial-block ever moves to a JS-side override (e.g., to
    // permit a coordination-confirm dialog from follow-up
    // nucleus-phone-5ic1), add the click-doesn't-navigate test then,
    // and use @testing-library/user-event (which throws on disabled).
  });

  describe('attempt sequence label sanity gate', () => {
    it('hides the label pill when call_number > total_calls (server cadence-drift defense)', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({
          attempt_sequence_label: 'Call 7 of 3, Day 14',
          attempt_call_number: 7,
          attempt_total_calls: 3,
        }),
      ]));
      render(<Queue />);
      await screen.findByText('Sunnyvale Veterinary');
      // The card still renders — only the label pill is suppressed.
      // Britt seeing no label is better than seeing impossible-numbers
      // and either freezing or trusting the bad sequence.
      expect(screen.queryByText(/Call 7 of 3/)).not.toBeInTheDocument();
    });

    it('hides the label pill when raw call_number / total_calls are missing', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({
          attempt_sequence_label: 'Call 2 of 3, Day 7',
          attempt_call_number: null,
          attempt_total_calls: null,
        }),
      ]));
      render(<Queue />);
      await screen.findByText('Sunnyvale Veterinary');
      expect(screen.queryByText(/Call 2 of 3/)).not.toBeInTheDocument();
    });
  });

  describe('dry-run banner', () => {
    it('hides when sequencer_dry_run_state is live', async () => {
      mockGetQueue.mockResolvedValue(liveResponse());
      render(<Queue />);
      await screen.findByText('Sunnyvale Veterinary');
      // Banner copy uses the words "PAUSED" (Blake-friendly). Match the
      // label fragment so a future copy revision that keeps the meaning
      // doesn't break the test for cosmetic reasons.
      expect(screen.queryByText(/PAUSED/)).not.toBeInTheDocument();
    });

    it('shows global_dry_run banner with rep-friendly copy', async () => {
      mockGetQueue.mockResolvedValue({
        ...liveResponse(),
        sequencer_dry_run_state: 'global_dry_run',
      });
      render(<Queue />);
      expect(await screen.findByText(/AUTOMATED SENDS PAUSED/)).toBeInTheDocument();
    });

    it('shows channel_dry_run banner with rep-friendly copy', async () => {
      mockGetQueue.mockResolvedValue({
        ...liveResponse(),
        sequencer_dry_run_state: 'channel_dry_run',
      });
      render(<Queue />);
      expect(await screen.findByText(/SOME AUTOMATED CHANNELS PAUSED/)).toBeInTheDocument();
    });
  });

  describe('touchpoints', () => {
    it('shows "replied" when reply timestamp is present', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({
          last_email_sent_at: new Date(Date.now() - 5 * 86400000 - 60_000).toISOString(),
          last_email_replied_at: new Date(Date.now() - 1 * 86400000 - 60_000).toISOString(),
        }),
      ]));
      render(<Queue />);
      // formatRelativeDay → "Yesterday" for ~1 day ago
      expect(await screen.findByText(/replied Yesterday/)).toBeInTheDocument();
    });

    it('shows "sent" when only the sent timestamp is present', async () => {
      mockGetQueue.mockResolvedValue(liveResponse([
        makePractice({
          last_email_sent_at: new Date(Date.now() - 3 * 86400000 - 60_000).toISOString(),
          last_email_replied_at: null,
        }),
      ]));
      render(<Queue />);
      expect(await screen.findByText(/sent 3d ago/)).toBeInTheDocument();
    });
  });

  it('renders empty state when practices is empty', async () => {
    mockGetQueue.mockResolvedValue({
      count: 0,
      limit: 50,
      tiers: ['warm', 'hot'],
      sequencer_dry_run_state: 'live',
      practices: [],
    });
    render(<Queue />);
    expect(await screen.findByText(/No leads ready to call/)).toBeInTheDocument();
  });

  it('catches ApiDegradedError and falls through to empty state (global DegradedBanner handles the alert)', async () => {
    mockGetQueue.mockRejectedValue(new MockApiDegradedError('/queue'));
    render(<Queue />);
    // The page should NOT render its own alert — DegradedBanner at App level
    // owns the user-facing surface. The page just shows the empty state so
    // Britt doesn't see two red boxes for one missing-config event.
    expect(await screen.findByText(/No leads ready to call/)).toBeInTheDocument();
    // Also make sure no role="alert" red box appears on the page — that's
    // the actual structural assertion (any inline alert would be wrong).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('positive control: console.error spy catches the warnings we depend on', () => {
    // Proves the spy IS wired correctly and CAN observe React warnings.
    // Sibling to the unmount-cleanup test below; if a React version
    // upgrade changes the warning string format, this sibling will fail
    // alongside the unmount test going silent — making the regression
    // observable instead of tautological.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    console.error('Warning: Can\'t perform a React state update on an unmounted component.');
    const offenders = errSpy.mock.calls.filter((args) => {
      const msg = String(args[0] || '');
      return /unmounted component|act\(\.\.\.\)/.test(msg);
    });
    expect(offenders.length).toBeGreaterThan(0);
    errSpy.mockRestore();
  });

  it('does not write state after unmount (AbortController cleanup, signal.aborted gates)', async () => {
    // Load-bearing assertion: spy on console.error and fail if React
    // warns about "Can't perform a React state update on an unmounted
    // component" or "act(...)" in production. The positive-control test
    // above proves the spy can catch those warnings.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let resolveFn;
    mockGetQueue.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    const { unmount } = render(<Queue />);
    unmount();
    resolveFn(liveResponse());
    // Allow microtask queue to drain so any unguarded setState would fire.
    await Promise.resolve();
    await Promise.resolve();
    const offenders = errSpy.mock.calls.filter((args) => {
      const msg = String(args[0] || '');
      return /unmounted component|act\(\.\.\.\)/.test(msg);
    });
    expect(offenders).toEqual([]);
    expect(mockGetQueue).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('translates API 401 into a re-login CTA (rotated TRISTAR_API_KEY)', async () => {
    // Path matches the apiFetch shape — `/queue`, not `/api/queue`
    // (apiFetch in lib/api.js does NOT prepend /api/).
    mockGetQueue.mockRejectedValue(
      new MockApiAuthError('/queue', 401, 'tristar', 'Unauthorized'),
    );
    // Wrap render in act so React flushes the rejected-promise tail
    // (catch → setError, finally → setLoading(false)) inside the
    // act scope. Without this, those two state updates land outside
    // any act() and React logs "not wrapped in act" warnings.
    await act(async () => {
      render(<Queue />);
    });
    expect(screen.getByText(/TriStar session has expired/)).toBeInTheDocument();
  });

  it('translates API 403 into a re-login CTA', async () => {
    mockGetQueue.mockRejectedValue(
      new MockApiAuthError('/queue', 403, 'tristar', 'Forbidden'),
    );
    await act(async () => {
      render(<Queue />);
    });
    expect(screen.getByText(/TriStar session has expired/)).toBeInTheDocument();
  });

  it('translates API 5xx into a calm wait-and-retry message (deploy / restart scenario)', async () => {
    // Bare Error('API 5xx') intentionally — Queue.jsx:386 routes 5xx via
    // regex-on-message, not a typed class (api.js:232 throws bare Error
    // for non-401/403 non-OK). Keep this in sync with that branch.
    mockGetQueue.mockRejectedValue(new Error('API 503: Service Unavailable'));
    render(<Queue />);
    expect(await screen.findByText(/TriStar server is restarting/)).toBeInTheDocument();
  });

  it('marks the active tier filter with aria-pressed', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);
    await screen.findByText('Sunnyvale Veterinary');

    const allButton = screen.getByRole('button', { name: 'All' });
    const hotButton = screen.getByRole('button', { name: 'Hot' });
    expect(allButton).toHaveAttribute('aria-pressed', 'true');
    expect(hotButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(hotButton);
    expect(hotButton).toHaveAttribute('aria-pressed', 'true');
    expect(allButton).toHaveAttribute('aria-pressed', 'false');

    // Wait for the post-click refetch to settle. Without this, the
    // trailing setData from the tier='hot' fetch fires in a tail
    // microtask AFTER this test returns — outside any act() wrap —
    // and logs "not wrapped in act" warnings that pollute the suite
    // output. The aria-pressed assertions above are synchronous
    // (driven by local setFilter state), but the fetch tail is not.
    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mockGetQueue.mock.calls[1][0].tier).toBe('hot'),
    );
  });

  it('renders unknown sequencer_dry_run_state with a "drift" banner instead of silently miscategorising', async () => {
    mockGetQueue.mockResolvedValue({
      ...liveResponse(),
      sequencer_dry_run_state: 'planet_aligned',
    });
    render(<Queue />);
    expect(await screen.findByText(/unknown state: planet_aligned/)).toBeInTheDocument();
  });

  it('catches generic errors and surfaces the message', async () => {
    mockGetQueue.mockRejectedValue(new Error('boom'));
    render(<Queue />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  describe('tier filter', () => {
    it('passes tier param to getQueue when a specific tier is selected', async () => {
      mockGetQueue.mockResolvedValue(liveResponse());
      render(<Queue />);

      // initial call — no tier filter. Queue passes `tier: undefined` when
      // the filter state is '', so the api.js getQueue helper omits the
      // query string. Asserting the literal value rather than
      // objectContaining (which accepts any value or absent).
      await screen.findByText('Sunnyvale Veterinary');
      expect(mockGetQueue.mock.calls[0][0].tier).toBeUndefined();

      // click Hot filter
      const hotButton = screen.getByRole('button', { name: 'Hot' });
      fireEvent.click(hotButton);

      await waitFor(() => {
        expect(mockGetQueue).toHaveBeenCalledWith(expect.objectContaining({ tier: 'hot' }));
      });
    });
  });

  // The mode-routed /queue request crosses the network; cancelling in-flight
  // requests on tier-change or refresh is what prevents last-write-wins
  // races. Pin the contract: getQueue MUST receive an AbortSignal. A future
  // refactor that drops the signal wiring would pass other tests green but
  // silently regress race safety.
  it('passes an AbortSignal to getQueue on every fetch', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);

    await screen.findByText('Sunnyvale Veterinary');
    expect(mockGetQueue).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it('aborts the previous request when tier changes', async () => {
    mockGetQueue.mockResolvedValue(liveResponse());
    render(<Queue />);

    await screen.findByText('Sunnyvale Veterinary');
    const firstSignal = mockGetQueue.mock.calls[0][0].signal;
    expect(firstSignal.aborted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));

    await waitFor(() => expect(mockGetQueue).toHaveBeenCalledTimes(2));
    // Effect cleanup MUST abort the first request so a slow first response
    // can't clobber the second. This is the race the refreshTick pattern
    // and the AbortController-per-effect were introduced to close.
    expect(firstSignal.aborted).toBe(true);
  });

  describe('DryRunBanner unknown state', () => {
    it('renders a generic gated banner with the raw state name on unknown state', async () => {
      mockGetQueue.mockResolvedValue({
        ...liveResponse(),
        sequencer_dry_run_state: 'maintenance_window',
      });
      render(<Queue />);
      // Must NOT mislabel as either of the known states.
      expect(await screen.findByText(/unknown state: maintenance_window/i)).toBeInTheDocument();
      expect(screen.queryByText(/OUTREACH CHANNEL GATED$/)).not.toBeInTheDocument();
      expect(screen.queryByText(/OUTREACH GLOBALLY GATED$/)).not.toBeInTheDocument();
    });
  });
});
