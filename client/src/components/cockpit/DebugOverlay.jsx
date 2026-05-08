/**
 * DebugOverlay — small fixed overlay on Cockpit for admins.
 * Shows WebSocket connected/disconnected, call phase, callId.
 * Rendered on both /cockpit/:id (real) and /practice.
 */
export default function DebugOverlay({ wsConnected, callPhase, callId }) {
  return (
    <div
      className="fixed bottom-20 right-3 z-50 flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-mono shadow-lg"
      style={{ background: 'rgba(42,18,19,0.92)', border: '1px solid rgba(92,57,43,0.5)' }}
    >
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ background: wsConnected ? '#22C55E' : '#DC2626' }}
      />
      <span style={{ color: 'rgba(239,209,175,0.7)' }}>
        WS: {wsConnected ? 'connected' : 'disconnected'}
      </span>
      <span style={{ color: 'rgba(239,209,175,0.35)' }}>|</span>
      <span style={{ color: '#F2B86A' }}>{callPhase}</span>
      {callId && (
        <>
          <span style={{ color: 'rgba(239,209,175,0.35)' }}>|</span>
          <span style={{ color: 'rgba(239,209,175,0.5)' }}>{callId.length > 20 ? callId.slice(0, 18) + '…' : callId}</span>
        </>
      )}
    </div>
  );
}
