import { useEffect, useState } from 'react';

/**
 * DegradedBanner — bead nucleus-phone-gxt2 / stardust-tristar [coc.1.b].
 *
 * Surfaces api.js's DEGRADED-target state to the operator. Listens for
 * two window events dispatched by client/src/lib/api.js:
 *
 *   'api:degraded'   — api.js refused to fire a routed call because
 *                      mode === TRISTAR but tristarBaseUrl/Key are
 *                      missing. Banner shows with the failing path.
 *   'api:tristar-ok' — a TARGETS.TRISTAR fetch returned ok, proving
 *                      config is good. Banner clears (auto-clear, per
 *                      gxt2 design choice). User can also dismiss.
 *
 * Auto-clear is conservative: only a clean ok (not a 500 from TriStar)
 * counts as recovery. Dismiss is per-session; reload resets state. The
 * banner is mounted at App level (App.jsx), not Shell, so the Cockpit
 * route (which renders without Shell) also sees it — the cockpit is
 * where the routed paths fire from.
 */
export default function DegradedBanner() {
  const [state, setState] = useState({ visible: false, path: null, at: null });

  useEffect(() => {
    function onDegraded(e) {
      const { path, timestamp } = e.detail || {};
      setState({ visible: true, path: path || '(unknown)', at: timestamp || Date.now() });
    }

    function onTristarOk() {
      setState((s) => (s.visible ? { visible: false, path: null, at: null } : s));
    }

    window.addEventListener('api:degraded', onDegraded);
    window.addEventListener('api:tristar-ok', onTristarOk);
    return () => {
      window.removeEventListener('api:degraded', onDegraded);
      window.removeEventListener('api:tristar-ok', onTristarOk);
    };
  }, []);

  if (!state.visible) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="bg-aunshin-alert/15 border-b border-aunshin-alert/40 px-4 py-2 text-center text-[12px] text-aunshin-alert shrink-0 flex items-center justify-center gap-3"
    >
      <span className="font-semibold tracking-wide uppercase text-[10px]">TriStar mode</span>
      <span>config missing — call to <code className="font-mono">{state.path}</code> was blocked. Ask Tom.</span>
      <button
        type="button"
        onClick={() => setState({ visible: false, path: null, at: null })}
        className="ml-2 underline text-[11px] hover:opacity-80"
        aria-label="Dismiss TriStar config banner"
      >
        Dismiss
      </button>
    </div>
  );
}
