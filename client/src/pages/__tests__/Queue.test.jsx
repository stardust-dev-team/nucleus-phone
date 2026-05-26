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
 *
 * NOT covered here (out of scope for this bead):
 *   - Multi-in_progress-attempts warning (deferred to nucleus-tristar-40o
 *     + the not-yet-built disposition modal)
 *   - End-to-end mode routing through api.js → mode-router (covered by
 *     api.test.js and mode-router.test.js — that's the contract this
 *     page consumes, not redefines)
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockNavigate = jest.fn();
// requireActual + override: preserves anything else this page might import
// from react-router-dom in future (Link, NavLink, Outlet) without silently
// returning undefined. Today only useNavigate is consumed. (Linus pass-1 P3
// future-proofing.)
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock getQueue + ApiDegradedError before importing the component. The
// component imports both from ../lib/api at module load — the mock has to
// be in place before that import is resolved.
//
// jest.mock factories are hoisted ABOVE top-level const/class declarations,
// so the mock class is defined inside the factory and re-exported for use
// in test bodies via the imported api module reference below.
const mockGetQueue = jest.fn();
jest.mock('../../lib/api', () => {
  class ApiDegradedError extends Error {
    constructor(path) {
      super(`degraded: ${path}`);
      this.name = 'ApiDegradedError';
      this.path = path;
    }
  }
  return {
    getQueue: (...args) => mockGetQueue(...args),
    ApiDegradedError,
  };
});

import Queue from '../Queue';
import { ApiDegradedError as MockApiDegradedError } from '../../lib/api';

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
    // 1-minute buffer absorbs CI clock jitter (Linus pass-3 P2-1 fix).
    last_email_sent_at: new Date(Date.now() - 3 * 86400000 - 60_000).toISOString(),
    last_email_replied_at: null,
    last_linkedin_dm_sent_at: null,
    last_linkedin_dm_replied_at: null,
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
    expect(screen.queryByText(/TriStar mode config is missing/)).not.toBeInTheDocument();
  });

  it('does not write state after unmount (AbortController cleanup, signal.aborted gates)', async () => {
    // Load-bearing assertion: spy on console.error and fail if React
    // warns about "Can't perform a React state update on an unmounted
    // component" or "act(...)" in production. Without this spy the test
    // is tautological — it would pass even if the signal.aborted guards
    // were ripped out (Linus pass-2 P2-1 fix).
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
    mockGetQueue.mockRejectedValue(new Error('API 401: Unauthorized'));
    render(<Queue />);
    expect(await screen.findByText(/TriStar session has expired/)).toBeInTheDocument();
  });

  it('translates API 403 into a re-login CTA', async () => {
    mockGetQueue.mockRejectedValue(new Error('API 403: Forbidden'));
    render(<Queue />);
    expect(await screen.findByText(/TriStar session has expired/)).toBeInTheDocument();
  });

  it('translates API 5xx into a calm wait-and-retry message (deploy / restart scenario)', async () => {
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

      // initial call — no tier filter (Queue passes `tier: undefined` when
      // the filter state is '', so the api.js getQueue helper omits the
      // query string). Linus pass-2 N-4 tightening: assert literal value.
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
  // silently regress race safety. (Linus pass-1 P2.)
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

  describe('DryRunBanner unknown state (Linus pass-1 P1)', () => {
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
