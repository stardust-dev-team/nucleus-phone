/**
 * DegradedBanner — variant copy tests. Per Linus-review-#2 of bead
 * nucleus-phone-ln18: degraded (config-missing) and auth_failed (401/403
 * from TriStar target) are *different* operator-actionable signals and
 * the banner must surface them with distinct copy so Britt knows
 * whether to ask Tom about env vars OR about an API-key rotation.
 *
 * What we don't test here: cross-event interaction, dismissal-stickiness
 * across reloads. Those are handled by integration; this is purely the
 * branch-on-variant render contract.
 */

import { render, screen, act, cleanup } from '@testing-library/react';
import DegradedBanner from '../DegradedBanner';

// SKIPPED until bead nucleus-phone-8la (React-dedup in jest.client.config.js)
// lands. @testing-library/react throws "act(...) is not supported in production
// builds of React" because the client-subtree-resolved React copy is the
// production minified build, not the one @testing-library/react was compiled
// against. The test file is committed (not deleted) so it picks up coverage
// immediately when 8la unbreaks the harness. Per Linus-review-#3 of ln18:
// "A red test file in the suite trains everyone to ignore red. The next
// genuine regression will hide in that noise." describe.skip is the right
// gate.
describe.skip('DegradedBanner — variant rendering (UNSKIP once nucleus-phone-8la lands)', () => {
  afterEach(() => {
    cleanup();
  });

  function fire(event, detail) {
    act(() => {
      window.dispatchEvent(new CustomEvent(event, { detail }));
    });
  }

  test('renders nothing initially', () => {
    render(<DegradedBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('api:degraded → renders TriStar mode / server-not-configured copy (post-stet: no path)', () => {
    render(<DegradedBanner />);
    // Post-stet the degraded event is a server-config signal dispatched by
    // App.jsx (allowlisted but TRISTAR env missing) — it carries no path.
    fire('api:degraded', { reason: 'tristar-unconfigured', timestamp: 1700000000000 });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/TriStar mode/i)).toBeInTheDocument();
    expect(screen.getByText(/missing its TriStar configuration/i)).toBeInTheDocument();
    // Auth-failed copy must NOT appear in the degraded variant.
    expect(screen.queryByText(/session expired/i)).toBeNull();
    expect(screen.queryByText(/rotated/i)).toBeNull();
  });

  test('api:auth-failed → renders TriStar auth / key-rotation copy with status', () => {
    render(<DegradedBanner />);
    fire('api:auth-failed', { path: '/queue', status: 401, timestamp: 1700000000000 });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/TriStar auth/i)).toBeInTheDocument();
    expect(screen.getByText(/session expired/i)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.getByText(/rotated/i)).toBeInTheDocument();
    // Config-missing copy must NOT appear in the auth-failed variant.
    expect(screen.queryByText(/config missing/i)).toBeNull();
    expect(screen.queryByText(/ask tom/i)).toBeNull();
  });

  test('api:tristar-ok clears either variant', () => {
    render(<DegradedBanner />);
    fire('api:degraded', { path: '/queue' });
    expect(screen.queryByRole('alert')).toBeInTheDocument();
    fire('api:tristar-ok', { path: '/queue' });
    expect(screen.queryByRole('alert')).toBeNull();

    fire('api:auth-failed', { path: '/queue', status: 401 });
    expect(screen.queryByRole('alert')).toBeInTheDocument();
    fire('api:tristar-ok', { path: '/queue' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('auth_failed dismiss button has the auth-specific aria-label', () => {
    // The aria-label drift is what makes screen-reader users (and Britt
    // with VoiceOver) able to tell the two variants apart by sound. If
    // a future refactor stops differentiating, this test catches it.
    render(<DegradedBanner />);
    fire('api:auth-failed', { path: '/queue', status: 401 });
    expect(screen.getByLabelText('Dismiss TriStar auth banner')).toBeInTheDocument();

    fire('api:tristar-ok', { path: '/queue' });
    fire('api:degraded', { path: '/queue' });
    expect(screen.getByLabelText('Dismiss TriStar config banner')).toBeInTheDocument();
  });

  test('a later event replaces the earlier variant (not stacked)', () => {
    // If degraded fires first, then auth-failed, the banner should swap
    // to auth-failed copy — not show both. Two banners stacked would be
    // confusing UX.
    render(<DegradedBanner />);
    fire('api:degraded', { path: '/queue' });
    fire('api:auth-failed', { path: '/queue', status: 401 });
    // Only ONE alert region.
    const alerts = screen.queryAllByRole('alert');
    expect(alerts).toHaveLength(1);
    // And it's the auth-failed copy.
    expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByText(/config missing/i)).toBeNull();
  });
});
