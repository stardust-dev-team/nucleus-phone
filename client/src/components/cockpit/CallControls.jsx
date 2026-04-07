import { useState } from 'react';
import { formatTime } from '../../lib/format';

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

export default function CallControls({ callPhase, timer, onCallNow, onEndCall, onSaveNext, disabled, onSendDigits, onToggleMute, muted }) {
  const [showKeypad, setShowKeypad] = useState(false);

  return (
    <div
      className="sticky bottom-0 z-10 shrink-0 transition-colors duration-300"
      style={{
        background: 'var(--cockpit-footer-bg)',
        borderTop: '1px solid var(--cockpit-card-border)',
        position: 'relative',
      }}
    >
      {/* Keypad popup — anchored above footer */}
      {showKeypad && callPhase === 'active' && (
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-lg shadow-lg p-4"
          style={{
            bottom: '100%',
            marginBottom: '8px',
            background: 'var(--cockpit-card)',
            border: '1px solid var(--cockpit-card-border)',
          }}
        >
          <div className="grid grid-cols-3 gap-2 w-48 mb-3">
            {DIGITS.map((d) => (
              <button
                key={d}
                onClick={() => onSendDigits?.(d)}
                className="w-14 h-14 rounded-lg text-lg font-medium flex items-center justify-center transition-colors cursor-pointer"
                style={{
                  background: 'var(--cockpit-card)',
                  border: '1px solid var(--cockpit-card-border)',
                  color: 'var(--cockpit-text)',
                }}
                onMouseDown={(e) => e.preventDefault()}
              >
                {d}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowKeypad(false)}
            className="w-full text-center text-xs py-1 cursor-pointer"
            style={{ color: 'var(--cockpit-text-muted)' }}
          >
            Close
          </button>
        </div>
      )}

      <div className="flex items-center justify-center gap-3 px-4 py-2">
        {callPhase === 'pre' && (
          <button
            onClick={onCallNow}
            disabled={disabled}
            className="w-full max-w-[400px] py-3 rounded text-sm font-semibold text-white flex items-center justify-center gap-2 transition-opacity disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
            style={{ background: 'var(--cockpit-blue-500)' }}
          >
            📞 Call now
          </button>
        )}

        {callPhase === 'active' && (
          <div className="flex items-center gap-3 w-full max-w-[500px] justify-center">
            {/* Mute */}
            <button
              onClick={onToggleMute}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-colors cursor-pointer shrink-0"
              style={{
                background: muted ? 'var(--cockpit-red-bg)' : 'var(--cockpit-card)',
                border: '1px solid var(--cockpit-card-border)',
              }}
              title={muted ? 'Unmute' : 'Mute'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                style={{ color: muted ? 'var(--cockpit-red-text)' : 'var(--cockpit-text-muted)' }}>
                {muted ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                )}
              </svg>
            </button>

            {/* Keypad toggle */}
            <button
              onClick={() => setShowKeypad(!showKeypad)}
              className="w-10 h-10 rounded-full flex items-center justify-center transition-colors cursor-pointer shrink-0"
              style={{
                background: showKeypad ? 'var(--cockpit-blue-500)' : 'var(--cockpit-card)',
                border: '1px solid var(--cockpit-card-border)',
              }}
              title="Keypad"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
                style={{ color: showKeypad ? '#fff' : 'var(--cockpit-text-muted)' }}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
            </button>

            {/* Timer */}
            <div
              className="flex items-center gap-2 px-5 py-2 rounded flex-1 justify-center"
              style={{
                background: 'var(--cockpit-green-50)',
                border: '1px solid var(--cockpit-green-500-20)',
              }}
            >
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ background: 'var(--cockpit-green-500)' }}
              />
              <span className="text-sm font-normal" style={{ color: 'var(--cockpit-green-900)' }}>
                On call — {formatTime(timer)}
              </span>
            </div>

            {/* End call */}
            <button
              onClick={() => { setShowKeypad(false); onEndCall(); }}
              className="px-4 py-2 rounded text-sm font-normal cursor-pointer shrink-0"
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
            className="w-full max-w-[400px] py-3 rounded text-sm font-semibold text-white cursor-pointer"
            style={{ background: 'var(--cockpit-blue-500)' }}
          >
            Save &amp; next &rarr;
          </button>
        )}
      </div>
    </div>
  );
}
