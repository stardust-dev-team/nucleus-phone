import LiveAnalysis from './LiveAnalysis';
import ConversationNavigator from './ConversationNavigator';

/**
 * LiveContainer — wraps LiveAnalysis (equipment) with the optional
 * Conversation Navigator underlay.
 *
 * Layering rule (per plan): Navigator sits BELOW LiveAnalysis in the DOM.
 * LiveAnalysis dominates when equipment is detected; when equipment is
 * absent (~80% of call time), the Navigator fills the visual space because
 * LiveAnalysis collapses to its idle listening state.
 *
 * The `data` prop is the full return of `useLiveAnalysis` — we spread
 * equipment fields into LiveAnalysis and route navigator fields into
 * ConversationNavigator.
 */
export default function LiveContainer({ data, active, contact, callId, isPractice = false, navigatorEnabled = true }) {
  const safe = data || {};

  // jsec-z4ff: the server authorizes `subscribe` by conference ownership and
  // answers a refusal with `subscribe_denied`. Say so.
  //
  // Without this the socket connects, the subscription is refused, and the
  // cockpit renders its normal idle state forever — indistinguishable from a
  // quiet call or a broken transcription pipeline. The first version of this
  // change added the flag to the hook and nothing read it, which meant the
  // failure it was written to make visible stayed invisible.
  if (safe.accessDenied) {
    const isMine = safe.accessDenied.reason === 'not your call';
    return (
      <div className="flex flex-col gap-2 min-h-0 p-4 rounded-aunshin bg-aunshin-twilight-2 border border-aunshin-rule-d">
        <div className="text-sm font-medium text-aunshin-ink-1">Live analysis unavailable</div>
        <div className="text-xs text-aunshin-ink-2">
          {isMine
            ? 'This call belongs to another rep. Live transcript and coaching are only shown to the rep on the call, and to admins.'
            : 'This call is no longer active, so there is nothing to stream.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 min-h-0">
      <LiveAnalysis
        data={safe}
        active={active}
        contact={contact}
        callId={callId}
        isPractice={isPractice}
      />
      {navigatorEnabled && (
        <ConversationNavigator
          phase={safe.phase}
          sentiment={safe.sentiment}
          suggestionHistory={safe.suggestionHistory}
          navigatorStatus={safe.navigatorStatus}
        />
      )}
    </div>
  );
}
