import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getQueue, ApiDegradedError } from '../lib/api';
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
 * Multi-in_progress-attempts warning is NOT implemented in this bead —
 * /queue currently exposes only the single due attempt per practice
 * (LIMIT 1 LATERAL in queue.js:165-175). Filed as a nucleus-tristar
 * follow-up; the disposition modal that surfaces the warning doesn't
 * exist in nucleus-phone yet either. See bead description for context.
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

function TierBadge({ tier }) {
  const style = TIER_STYLES[tier] || { badge: 'bg-gray-500' };
  return (
    <span className={`${style.badge} text-white px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide`}>
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
  const dialTarget = row.owner_phone || row.practice_phone;
  const tierStyle = TIER_STYLES[row.intent_tier] || { border: 'border-gray-500' };

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
        {row.attempt_sequence_label && (
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
          onClick={() => dialTarget && onCall(dialTarget)}
          disabled={!dialTarget}
          className={
            dialTarget
              ? 'bg-aunshin-sodium text-aunshin-twilight-2 px-4 py-2 rounded-lg font-mono text-lg font-semibold hover:opacity-90 transition-opacity'
              : 'bg-gray-500/30 text-aunshin-quiet-d px-4 py-2 rounded-lg font-mono text-sm'
          }
          aria-label={dialTarget ? `Call ${ownerName || row.practice_name} at ${dialTarget}` : 'No phone number on file'}
        >
          {dialTarget || 'no phone'}
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
  // (Linus pass-1 P1 fix.)
  let label;
  let detail;
  if (state === 'global_dry_run') {
    label = 'OUTREACH GLOBALLY GATED';
    detail = 'Sequencer is in dry-run — no email or LinkedIn DMs are being sent. Touchpoint timestamps reflect prior live runs only.';
  } else if (state === 'channel_dry_run') {
    label = 'OUTREACH CHANNEL GATED';
    detail = 'One or more outreach channels (Instantly or PhantomBuster) are in dry-run. Some touchpoints below may not reflect real sends.';
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
  const [data, setData] = useState({ practices: [], sequencer_dry_run_state: null, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tier, setTier] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Single owner for fetch lifecycle: this effect. The Refresh button
  // bumps refreshTick to re-run the effect with a fresh AbortController
  // instead of calling fetchQueue directly. Closes the Linus pass-1 P1
  // race where a manual refresh path bypassed abort plumbing — N rapid
  // clicks would otherwise produce N concurrent fetches with last-write-wins.
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
        // close the stale-write race (Linus pass-1 P1).
        if (signal.aborted) return;
        setData({
          practices: res.practices || [],
          sequencer_dry_run_state: res.sequencer_dry_run_state || null,
          count: res.count || 0,
        });
      })
      .catch((err) => {
        if (signal.aborted || err.name === 'AbortError') return;
        if (err instanceof ApiDegradedError) {
          // Global DegradedBanner (App.jsx) already surfaces this. Clear
          // local data so the empty state shows instead of double-rendering
          // the alert. The banner is the canonical surface for missing
          // TriStar config (Linus pass-1 P2 dual-alert fix).
          setData({ practices: [], sequencer_dry_run_state: null, count: 0 });
          return;
        }
        // 401/403 from nucleus-tristar means the shared TRISTAR_API_KEY
        // has rotated since the cockpit booted (configureApi captured the
        // old key at /me time). The raw apiFetch error reads "API 401:
        // <body>" — useless to Britt. Translate to a re-login CTA. A
        // proper typed ApiAuthError from apiFetch would let every consumer
        // benefit; tracked as nucleus-phone follow-up (Linus pass-2 P1-1).
        if (/^API 40[13]:/.test(err.message || '')) {
          setError('Your TriStar session has expired. Please log out and back in.');
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
            * about the row count being rendered (Linus pass-2 N-2 fix). */}
          {!loading && data.practices.length > 0 && (
            <span className="ml-2 text-sm text-aunshin-quiet-d font-normal">
              {data.practices.length} due
            </span>
          )}
        </h1>
        <button
          type="button"
          onClick={() => setRefreshTick((n) => n + 1)}
          disabled={loading}
          className="text-[11px] uppercase tracking-wider text-aunshin-sodium hover:text-aunshin-peach-light disabled:opacity-50"
          aria-label="Refresh queue"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <DryRunBanner state={data.sequencer_dry_run_state} />

      {/* Tier filter */}
      <div className="flex gap-2 mb-4">
        {TIER_FILTERS.map((opt) => (
          <button
            key={opt.value || 'all'}
            type="button"
            onClick={() => setTier(opt.value)}
            className={
              tier === opt.value
                ? 'px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-wider font-semibold bg-aunshin-sodium text-aunshin-twilight-2'
                : 'px-3 py-1.5 rounded-lg text-[11px] uppercase tracking-wider text-aunshin-quiet-d border border-aunshin-rule-d hover:text-aunshin-peach-light'
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
        <div className="text-aunshin-quiet-d text-sm py-12 text-center">Loading queue…</div>
      )}

      {!loading && !error && data.practices.length === 0 && (
        <div className="text-aunshin-quiet-d text-sm py-12 text-center">
          No practices due. The sequencer has nothing in the phone pipeline right now.
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
