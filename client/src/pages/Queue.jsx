import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getQueue, ApiDegradedError, ApiAuthError } from '../lib/api';
import { formatRelativeDay } from '../lib/format';

/**
 * TriStarQueueView — bead nucleus-phone-e91e / stardust-tristar [coc.1.c].
 *
 * Lead-view for the TriStar veterinary M&A queue. Renders the sequencer-due
 * phone-attempt list returned by nucleus-tristar /queue (mode-routed via
 * api.js getQueue → mode-router → nucleus-tristar deployment).
 *
 * Field contract — required by the bead, shape pinned by nucleus-tristar's
 * test/phone.queue.test.js (PRACTICE_ROW_KEYS):
 *   practice_name, owner_first_name + owner_last_name, owner_phone (MOST
 *   CRITICAL — dial target), owner_email, owner_title, intent_tier,
 *   attempt_sequence_label, cadence_profile, last_email_sent_at,
 *   last_email_replied_at, last_linkedin_dm_sent_at,
 *   last_linkedin_dm_replied_at.
 *
 * Dry-run banner: response.sequencer_dry_run_state !== 'live' surfaces a
 * top-of-page warning. This is the server-wide outreach state (not per-row),
 * so it lives outside the practice list.
 *
 * Click action: row → /cockpit/<owner_phone> (falls back to practice_phone
 * if owner_phone is null). Cockpit takes phone as its identifier; this
 * keeps Britt's flow single-tap.
 *
 * Degraded-config (ApiDegradedError) is caught here but rendered as a
 * row-level error message — the global DegradedBanner.jsx (mounted in
 * App.jsx) already surfaces the alert globally. We don't double-render
 * the banner; we just keep the page useful (showing the error inline so
 * the page doesn't go blank).
 *
 * Multi-in_progress dial-block (bead nucleus-phone-02k6):
 *   Block triggers when row.phone_in_progress_count > 1. Modal-half +
 *   staleness analysis: bead nucleus-phone-u3al. 48h lockout risk via
 *   PHONE_RECONCILIATION_HOURS: bead nucleus-phone-5ic1.
 */

const TIER_STYLES = {
  hot: {
    badge: 'bg-aunshin-alert',
    border: 'border-aunshin-alert',
    text: 'text-aunshin-alert',
  },
  warm: {
    badge: 'bg-aunshin-sodium',
    border: 'border-aunshin-sodium',
    text: 'text-aunshin-sodium',
  },
};

// Module-level dedupe so re-renders don't spam the console on the same
// unknown tier value. Cleared on full reload only (intentional — the goal
// is "ops notices drift once," not "log every paint"). Do NOT move into
// the component: useRef would persist across re-renders of the SAME
// TierBadge but reset for each new instance. Two rows with the same
// unknown tier would each warn once, defeating the dedupe. Module-level
// Set survives both axes (re-render AND new instance).
const _warnedTiers = new Set();

function TierBadge({ tier }) {
  const style = TIER_STYLES[tier];
  if (!style && tier && !_warnedTiers.has(tier)) {
    _warnedTiers.add(tier);
    console.warn(
      `[queue] unknown intent_tier '${tier}' — TIER_STYLES needs an entry; row will render as gray`,
    );
  }
  const resolved = style || { badge: 'bg-gray-500' };
  return (
    <span className={`${resolved.badge} text-white px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide`}>
      {tier}
    </span>
  );
}

/**
 * Touchpoint — one of the four last_*_{sent,replied}_at fields.
 * Compact label + relative time, or "—" when never touched. Replied
 * trumps sent visually so Britt can spot active conversations at a glance.
 */
function Touchpoint({ label, sentAt, repliedAt }) {
  if (repliedAt) {
    return (
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-aunshin-quiet-d">{label}</span>
        <span className="text-[11px] text-aunshin-success font-medium">
          replied {formatRelativeDay(repliedAt)}
        </span>
      </div>
    );
  }
  if (sentAt) {
    return (
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wide text-aunshin-quiet-d">{label}</span>
        <span className="text-[11px] text-aunshin-peach-light">
          sent {formatRelativeDay(sentAt)}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-aunshin-quiet-d">{label}</span>
      <span className="text-[11px] text-aunshin-quiet-d">—</span>
    </div>
  );
}

function PracticeCard({ row, onCall }) {
  const ownerName = [row.owner_first_name, row.owner_last_name].filter(Boolean).join(' ').trim();
  const rawDialTarget = row.owner_phone || row.practice_phone;
  // Normalize before validating. Server normalization is best-effort across
  // HubSpot manual edits, NPPES backfill, and stale joins — common real-
  // world shapes include '(602) 555-1234', '602-555-1234', '602.555.1234',
  // '+1 602 555 1234'. Strip everything except digits + leading '+', then
  // check E.164-ish length. Forwards the NORMALIZED form to /cockpit/:id
  // so the URL is always clean regardless of upstream formatting drift.
  //
  // Junk values ('0', 'see notes', '(no phone listed)') still fail the
  // length check and resolve to null, which flows through the existing
  // `!dialTarget` disabled-state — no parallel rendering branch.
  const normalizedDial = String(rawDialTarget || '').replace(/[^\d+]/g, '');
  const dialTarget = /^\+?\d{10,15}$/.test(normalizedDial) ? normalizedDial : null;
  const tierStyle = TIER_STYLES[row.intent_tier] || { border: 'border-gray-500' };

  // Defense against future serialization drift. 0 is the safe-fail
  // direction (don't block dialing when we can't read the count).
  const inProgressCount = Number.isFinite(row.phone_in_progress_count)
    ? row.phone_in_progress_count
    : 0;
  const multiInProgress = inProgressCount > 1;
  const dialBlocked = !dialTarget || multiInProgress;

  return (
    <div
      className={`rounded-xl bg-aunshin-twilight-2 border-l-4 ${tierStyle.border} border border-aunshin-rule-d p-4 flex flex-col gap-3`}
    >
      {/* Header row: tier, practice name, attempt sequence */}
      <div className="flex items-center gap-3 flex-wrap">
        <TierBadge tier={row.intent_tier} />
        <span className="font-semibold text-sm text-aunshin-peach-light">
          {row.practice_name || '(unnamed practice)'}
        </span>
        {/* attempt_sequence_label is server-interpolated at nucleus-tristar
          * queue.js:75 from CADENCES constants (callNumber, totalCalls,
          * day_offset — all integers from a hardcoded enum). Safe to
          * render as text. If queue.js ever interpolates a DB-sourced
          * string into this label, this safety claim needs re-evaluation.
          *
          * Sanity gate: hide the pill on any cadence-drift signal. Four
          * cases the gate must catch:
          *   1. call_number > total_calls   — "Call 7 of 3" (cadence step
          *      ordering mismatched the LATERAL pick in cadences.js)
          *   2. call_number < 1             — "Call 0 of N" (placeholder /
          *      uninitialized row)
          *   3. total_calls < 1             — "Call N of 0" (cadence with
          *      zero phone steps somehow surfaced)
          *   4. non-finite values (NaN/Infinity/strings) — server bug or
          *      JSON-cast surprise. Number.isFinite catches all of these
          *      BEFORE the numeric comparisons, which would otherwise
          *      return false for NaN but true for Infinity. Belt-and-
          *      suspenders against any future server-side serialization
          *      change. (Linus session-pass P2-6 fix.)
          * Britt seeing any of these is worse than seeing no label. */}
        {row.attempt_sequence_label
          && Number.isFinite(row.attempt_call_number)
          && Number.isFinite(row.attempt_total_calls)
          && row.attempt_call_number >= 1
          && row.attempt_total_calls >= 1
          && row.attempt_call_number <= row.attempt_total_calls && (
            <span className="text-[11px] font-mono text-aunshin-sodium bg-aunshin-sodium/10 px-2 py-0.5 rounded">
              {row.attempt_sequence_label}
            </span>
          )}
        {row.cadence_profile && (
          <span className="text-[10px] uppercase tracking-wide text-aunshin-quiet-d">
            {row.cadence_profile}
          </span>
        )}
      </div>

      {/* Multi-in-progress dial block (bead nucleus-phone-02k6). Surfaces
        * above the dial button when 2+ other phone attempts are already
        * in_progress on this practice. Rendered as a distinct row so it
        * sits between identity and dial target — the rep can't miss it
        * on the way to the button. role="alert" implies aria-live="assertive"
        * per ARIA spec — don't override with "polite," which conflicts on
        * NVDA/JAWS. The glyph is aria-hidden so AT reads only the words. */}
      {multiInProgress && (
        <div
          role="alert"
          className="bg-aunshin-alert/15 border border-aunshin-alert/40 rounded-lg px-3 py-2 text-[12px] text-aunshin-alert font-medium"
        >
          <span aria-hidden="true">⚠ </span>
          {inProgressCount} dialers active — coordinate before calling
        </div>
      )}

      {/* Owner identity + dial target — owner_phone is the most critical
        * field; it's the only piece Britt actually uses to dial. Make it
        * unmistakable: large, mono, sodium. */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-center">
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-wide text-aunshin-quiet-d">Owner</span>
          <span className="text-sm font-medium text-aunshin-peach-light">
            {ownerName || '(no owner on file)'}
            {row.owner_title && (
              <span className="text-aunshin-quiet-d font-normal"> · {row.owner_title}</span>
            )}
          </span>
          {row.owner_email && (
            <span className="text-[11px] text-aunshin-quiet-d truncate">{row.owner_email}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => onCall(dialTarget)}
          disabled={dialBlocked}
          className={
            dialBlocked
              ? 'bg-gray-500/30 text-aunshin-quiet-d px-4 py-2 rounded-lg font-mono text-sm cursor-not-allowed'
              : 'bg-aunshin-sodium text-aunshin-twilight-2 px-4 py-2 rounded-lg font-mono text-lg font-semibold hover:opacity-90 transition-opacity'
          }
          aria-label={
            multiInProgress
              ? `Dial blocked — ${inProgressCount} other dialers currently working ${ownerName || row.practice_name}`
              : (dialTarget ? `Call ${ownerName || row.practice_name} at ${dialTarget}` : 'No phone number on file')
          }
        >
          {multiInProgress ? 'dial blocked' : (dialTarget || 'no phone')}
        </button>
      </div>

      {/* Touchpoint grid: two channels (email + linkedin), four timestamps
        * total (sent + replied per channel). Two-column layout — the
        * grid was previously md:grid-cols-4 which left two empty cells. */}
      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-aunshin-rule-d/50">
        <Touchpoint label="Email" sentAt={row.last_email_sent_at} repliedAt={row.last_email_replied_at} />
        <Touchpoint label="LinkedIn DM" sentAt={row.last_linkedin_dm_sent_at} repliedAt={row.last_linkedin_dm_replied_at} />
      </div>
    </div>
  );
}

/**
 * Dry-run banner — fires when sequencer_dry_run_state is anything other
 * than 'live'. Surfaces the operator-visible fact that outreach is gated
 * server-side and replies/sends in the touchpoint grid may be stale.
 *
 * Three valid states (mirrored from nucleus-tristar queue.js
 * SEQUENCER_DRY_RUN_STATES): 'live' (no banner), 'global_dry_run' (all
 * outreach gated), 'channel_dry_run' (Instantly or PB specifically gated).
 */
function DryRunBanner({ state }) {
  if (state === 'live' || !state) return null;

  // Explicit per-state branch — DO NOT collapse the unknown case into a
  // default "channel gated" label. The enum lives across an HTTP boundary
  // (nucleus-tristar SEQUENCER_DRY_RUN_STATES); a fourth state added
  // there must NOT auto-mislabel here as "channel gated." Fail loud with
  // a generic warning + raw state name so ops notices the drift instead
  // of Britt seeing the wrong banner copy and acting on it.
  //
  let label;
  let detail;
  if (state === 'global_dry_run') {
    label = 'AUTOMATED SENDS PAUSED';
    detail = 'All automated email and LinkedIn sends are paused. You can still call. Touchpoints below reflect prior live runs only.';
  } else if (state === 'channel_dry_run') {
    label = 'SOME AUTOMATED CHANNELS PAUSED';
    detail = 'Some automated email or LinkedIn channels are paused. Touchpoint history may be incomplete. Calls work normally.';
  } else {
    label = `OUTREACH GATED (unknown state: ${state})`;
    detail = 'Server reported a sequencer state this client does not recognize. Surface to ops — nucleus-tristar SEQUENCER_DRY_RUN_STATES may have drifted from the client copy.';
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="bg-aunshin-sodium/15 border border-aunshin-sodium/40 rounded-lg px-4 py-3 mb-4 flex flex-col gap-1"
    >
      <span className="font-bold text-[11px] tracking-wider uppercase text-aunshin-sodium">
        {label}
      </span>
      <span className="text-[12px] text-aunshin-peach-light">
        {detail}
      </span>
    </div>
  );
}

const TIER_FILTERS = [
  { value: '', label: 'All' },
  { value: 'hot', label: 'Hot' },
  { value: 'warm', label: 'Warm' },
];

export default function TriStarQueueView() {
  const navigate = useNavigate();
  // count was tracked alongside practices for the header pill but the pill
  // now reads practices.length directly. Dropped here
  // (pass-3 N-4) so state isn't carrying a value nothing reads.
  const [data, setData] = useState({ practices: [], sequencer_dry_run_state: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tier, setTier] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Single owner for fetch lifecycle: this effect. The Refresh button
  // bumps refreshTick to re-run the effect with a fresh AbortController
  // instead of issuing a direct fetch. Closes the race where N rapid
  // refresh clicks would produce N concurrent fetches with last-write-wins.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    setError(null);

    getQueue({ tier: tier || undefined, signal })
      .then((res) => {
        // AbortController.abort() does NOT reject already-settled promises.
        // If the fetch resolved microseconds before the abort, .then still
        // runs with stale closures. Gate every write on signal.aborted to
        // close the stale-write race.
        if (signal.aborted) return;
        const rawPractices = res.practices || [];
        // Dedup by practice_id — duplicate keys make React reuse one row's
        // DOM, which leaks stale touchpoints + the wrong dial target into
        // the surviving row. A server-side LATERAL join misfire is the
        // typical cause; warn loud so it gets noticed instead of silently
        // dropping the second row.
        const seen = new Set();
        const practices = rawPractices.filter((row) => {
          if (seen.has(row.practice_id)) return false;
          seen.add(row.practice_id);
          return true;
        });
        if (practices.length !== rawPractices.length) {
          console.warn(
            `[queue] dropped ${rawPractices.length - practices.length} duplicate practice_id row(s); server may have a LATERAL join misfire`,
          );
        }
        // Virtualization trip-wire. The flat map below is fine through
        // 200-300 rows on Britt's iPad. ~500 is the actual "do something"
        // line — above that, scroll jank shows up; a react-window swap is
        // the next move. Threshold matches the comment so a steady 350-row
        // queue doesn't spam the console on every tier toggle / refresh.
        if (practices.length > 500) {
          console.warn(
            `[queue] ${practices.length} rows rendered flat — past ~500 consider react-window virtualization`,
          );
        }
        setData({
          practices,
          sequencer_dry_run_state: res.sequencer_dry_run_state || null,
        });
      })
      .catch((err) => {
        if (signal.aborted || err.name === 'AbortError') return;
        if (err instanceof ApiDegradedError) {
          // Global DegradedBanner (App.jsx) already surfaces this. Clear
          // local data so the empty state shows instead of double-rendering
          // the alert. The banner is the canonical surface for missing
          // TriStar config.
          setData({ practices: [], sequencer_dry_run_state: null });
          return;
        }
        // 401/403 surfaces as ApiAuthError (sj5m/7w3t). The TriStar-target
        // variant ALSO fires api:auth-failed → DegradedBanner shows the
        // ops-actionable "key rotation may be needed" copy. The local
        // string here is the user-actionable CTA for the case where the
        // banner is dismissed / not visible yet.
        if (err instanceof ApiAuthError) {
          setError('Your TriStar session has expired. Please log out and back in.');
          return;
        }
        // 5xx from nucleus-tristar typically means a deploy / restart in
        // progress. Britt can't act on a stack-trace message; surface a
        // calm wait-and-retry instead. No auto-poll — silent retry could
        // mask a real outage.
        if (/^API 5\d\d:/.test(err.message || '')) {
          setError('TriStar server is restarting. Tap Refresh in a moment.');
          return;
        }
        setError(err.message || 'Failed to load queue.');
      })
      .finally(() => {
        if (signal.aborted) return;
        setLoading(false);
      });

    return () => controller.abort();
  }, [tier, refreshTick]);

  function handleCall(phone) {
    navigate(`/cockpit/${encodeURIComponent(phone)}`);
  }

  return (
    <div className="px-4 py-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-aunshin-peach-light">
          TriStar Queue
          {/* Use practices.length over data.count so the pill never lies
            * about the row count being rendered. */}
          {!loading && data.practices.length > 0 && (
            <span className="ml-2 text-sm text-aunshin-quiet-d font-normal">
              {data.practices.length} due
            </span>
          )}
        </h1>
        {/* min-h-[44px] min-w-[44px] enforces Apple HIG tap target on iPad
          * landscape (Britt's primary device). px-3 py-2 keeps visual
          * weight modest. */}
        <button
          type="button"
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
          className="text-[11px] uppercase tracking-wider text-aunshin-sodium hover:text-aunshin-peach-light disabled:opacity-50 px-3 py-2 min-h-[44px] min-w-[44px]"
          aria-label="Refresh queue"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <DryRunBanner state={data.sequencer_dry_run_state} />

      {/* Tier filter — aria-pressed gives screen readers the toggle state.
        * min-h-[44px] enforces iPad tap target. */}
      <div className="flex gap-2 mb-4" role="group" aria-label="Filter by intent tier">
        {TIER_FILTERS.map((opt) => (
          <button
            key={opt.value || 'all'}
            type="button"
            onClick={() => setTier(opt.value)}
            aria-pressed={tier === opt.value}
            className={
              tier === opt.value
                ? 'px-4 py-2 min-h-[44px] rounded-lg text-[11px] uppercase tracking-wider font-semibold bg-aunshin-sodium text-aunshin-twilight-2'
                : 'px-4 py-2 min-h-[44px] rounded-lg text-[11px] uppercase tracking-wider text-aunshin-quiet-d border border-aunshin-rule-d hover:text-aunshin-peach-light'
            }
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="bg-aunshin-alert/15 border border-aunshin-alert/40 rounded-lg px-4 py-3 mb-4 text-[12px] text-aunshin-alert">
          {error}
        </div>
      )}

      {loading && data.practices.length === 0 && (
        <div
          role="status"
          aria-live="polite"
          className="text-aunshin-quiet-d text-sm py-12 text-center"
        >
          Loading queue…
        </div>
      )}

      {!loading && !error && data.practices.length === 0 && (
        <div className="text-aunshin-quiet-d text-sm py-12 text-center">
          No leads ready to call right now. Tap Refresh to check again.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {data.practices.map((row) => (
          <PracticeCard
            key={row.practice_id}
            row={row}
            onCall={handleCall}
          />
        ))}
      </div>
    </div>
  );
}
