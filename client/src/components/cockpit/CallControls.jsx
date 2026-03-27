import { formatTime } from '../../lib/format';

export default function CallControls({ callPhase, timer, onCallNow, onEndCall, onSaveNext, disabled }) {
  return (
    <div
      className="sticky bottom-0 z-10 flex items-center justify-center gap-3 px-5 py-2.5 transition-colors duration-300"
      style={{
        background: 'var(--cockpit-footer-bg)',
        borderTop: '1px solid var(--cockpit-card-border)',
      }}
    >
      {callPhase === 'pre' && (
        <button
          onClick={onCallNow}
          disabled={disabled}
          className="w-full max-w-[400px] py-3 rounded-lg text-[15px] font-semibold text-white flex items-center justify-center gap-2 transition-opacity disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
          style={{ background: 'var(--cockpit-blue-500)' }}
        >
          📞 Call now
        </button>
      )}

      {callPhase === 'active' && (
        <div className="flex items-center gap-4 w-full max-w-[400px] justify-center">
          <div
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg flex-1 justify-center"
            style={{
              background: 'var(--cockpit-green-50)',
              border: '1px solid var(--cockpit-green-500-20)',
            }}
          >
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: 'var(--cockpit-green-500)' }}
            />
            <span className="text-sm font-medium" style={{ color: 'var(--cockpit-green-900)' }}>
              On call — {formatTime(timer)}
            </span>
          </div>
          <button
            onClick={onEndCall}
            className="px-4 py-2.5 rounded-lg text-[13px] font-medium cursor-pointer"
            style={{
              background: 'var(--cockpit-red-bg)',
              color: 'var(--cockpit-red-text)',
            }}
          >
            End call
          </button>
        </div>
      )}

      {callPhase === 'post' && (
        <button
          onClick={onSaveNext}
          className="w-full max-w-[400px] py-3 rounded-lg text-[15px] font-semibold text-white cursor-pointer"
          style={{ background: 'var(--cockpit-blue-500)' }}
        >
          Save &amp; next &rarr;
        </button>
      )}
    </div>
  );
}
