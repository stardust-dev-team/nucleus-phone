import { useEffect, useState } from 'react';

/**
 * DegradedBanner — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.b].
 *
 * Surfaces api.js's TARGETS.DEGRADED state AND 401/403 auth failures from
 * TriStar-target routes to the operator. Listens for three window events
 * dispatched by client/src/lib/api.js:
 *
 *   'api:degraded'      — api.js refused to fire a routed call because
 *                         mode === TRISTAR but tristarBaseUrl/Key are
 *                         missing. Banner shows "config missing" variant
 *                         with the failing path.
 *   'api:auth-failed'   — A TARGETS.TRISTAR fetch returned 401/403. Most
 *                         common cause: TRISTAR_API_KEY rotated on the
 *                         nucleus-tristar service since the cockpit
 *                         booted (configureApi captured the old key at
 *                         /me time). Banner shows "session expired"
 *                         variant. Added per Linus-review-#2 of bead
 *                         nucleus-phone-ln18.
 *   'api:tristar-ok'    — A TARGETS.TRISTAR fetch returned ok, proving
 *                         config + key are good. Banner clears
 *                         (auto-clear, per gxt2 design choice). User
 *                         can also dismiss.
 *
 * Why two variants instead of one: the action the operator should take
 * is different. Config-missing means "ask Tom" — env var on Render
 * needs fixing. Auth-failed means "rotate the TRISTAR_API_KEY env on
 * nucleus-tristar AND redeploy nucleus-phone with the new key baked
 * into the bundle" — different ops procedure. Conflating them into a
 * single "TriStar broke somehow" message wastes Britt's time and Tom's.
 *
 * Auto-clear is conservative: only a clean ok (not a 500 from TriStar)
 * counts as recovery. Dismiss is per-session; reload resets state. The
 * banner is mounted at App level (App.jsx), not Shell, so the Cockpit
 * route (which renders without Shell) also sees it — the cockpit is
 * where the routed paths fire from.
 */
export default function DegradedBanner() {
  const [state, setState] = useState({ visible: false, variant: null, path: null, status: null, at: null });

  useEffect(() => {
    function onDegraded(e) {
      const { path, timestamp } = e.detail || {};
      setState({ visible: true, variant: 'degraded', path: path || '(unknown)', status: null, at: timestamp || Date.now() });
    }

    function onAuthFailed(e) {
      const { path, status, timestamp } = e.detail || {};
      setState({ visible: true, variant: 'auth_failed', path: path || '(unknown)', status: status || null, at: timestamp || Date.now() });
    }

    function onTristarOk() {
      setState((s) => (s.visible ? { visible: false, variant: null, path: null, status: null, at: null } : s));
    }

    window.addEventListener('api:degraded', onDegraded);
    window.addEventListener('api:auth-failed', onAuthFailed);
    window.addEventListener('api:tristar-ok', onTristarOk);
    return () => {
      window.removeEventListener('api:degraded', onDegraded);
      window.removeEventListener('api:auth-failed', onAuthFailed);
      window.removeEventListener('api:tristar-ok', onTristarOk);
    };
  }, []);

  if (!state.visible) return null;

  // Variant-specific copy. Operator should know what action to take from
  // the banner alone — not from a devtools console message.
  const copy = state.variant === 'auth_failed'
    ? {
        label: 'TriStar auth',
        body: (
          <>
            session expired (HTTP {state.status}). The shared TRISTAR_API_KEY may have rotated — reload the cockpit, or ask Tom to redeploy with the current key.
          </>
        ),
        dismissLabel: 'Dismiss TriStar auth banner',
      }
    : {
        label: 'TriStar mode',
        body: (
          <>
            config missing — call to <code className="font-mono">{state.path}</code> was blocked. Ask Tom.
          </>
        ),
        dismissLabel: 'Dismiss TriStar config banner',
      };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="bg-aunshin-alert/15 border-b border-aunshin-alert/40 px-4 py-2 text-center text-[12px] text-aunshin-alert shrink-0 flex items-center justify-center gap-3"
    >
      <span className="font-semibold tracking-wide uppercase text-[10px]">{copy.label}</span>
      <span>{copy.body}</span>
      <button
        type="button"
        onClick={() => setState({ visible: false, variant: null, path: null, status: null, at: null })}
        className="ml-2 underline text-[11px] hover:opacity-80"
        aria-label={copy.dismissLabel}
      >
        Dismiss
      </button>
    </div>
  );
}
