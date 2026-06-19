import { useEffect, useState } from 'react';

/**
 * DegradedBanner — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.b];
 * reworked by nucleus-phone-stet (P1).
 *
 * Surfaces TriStar misconfig + auth failures to the operator. Listens for three
 * window events:
 *
 *   'api:degraded'      — dispatched by App.jsx when /me reports the user is
 *                         allowlisted for TriStar but the SERVER is missing its
 *                         TRISTAR_API_BASE_URL/KEY (tristar.configured ===
 *                         false). The cockpit stays in Joruva mode; the banner
 *                         tells the operator the server needs fixing. Post-stet
 *                         this is a server-config signal, not a refused fetch —
 *                         there is no client-side key to be missing.
 *   'api:auth-failed'   — dispatched by api.js when a TARGETS.TRISTAR request
 *                         (through the /api/tristar/* proxy) returns 401/403.
 *                         Most common cause: TRISTAR_API_KEY rotated on the
 *                         nucleus-tristar service. Banner shows "auth" variant.
 *   'api:tristar-ok'    — a TARGETS.TRISTAR request returned ok. Banner clears
 *                         (auto-clear). User can also dismiss.
 *
 * Why two variants: the operator action differs. Config-missing means "set the
 * TriStar env on the nucleus-phone server." Auth-failed means "the shared key
 * was rotated on nucleus-tristar — update TRISTAR_API_KEY on nucleus-phone."
 * Both are "ask Tom," but the fix is different.
 *
 * Auto-clear is conservative: only a clean ok counts as recovery. Dismiss is
 * per-session; reload resets state. Mounted at App level (App.jsx), not Shell,
 * so the Cockpit route (which renders without Shell) sees it too.
 */
export default function DegradedBanner() {
  const [state, setState] = useState({ visible: false, variant: null, path: null, status: null, at: null });

  useEffect(() => {
    function onDegraded(e) {
      const { timestamp } = e.detail || {};
      setState({ visible: true, variant: 'degraded', path: null, status: null, at: timestamp || Date.now() });
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
            enabled for your account but the server is missing its TriStar configuration. Ask Tom.
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
