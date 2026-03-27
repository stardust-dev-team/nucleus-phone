import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTime } from '../lib/format';

const STATUS_TEXT = {
  connecting: 'Connecting...',
  ringing: 'Ringing...',
  connected: 'Connected',
  disconnected: 'Call Ended',
};

export default function Dialer({ identity, twilioHook, callState }) {
  const navigate = useNavigate();
  const { status, muted, toggleMute, sendDigits, call } = twilioHook;
  const { callData, elapsed, endCurrentCall } = callState;
  const [showKeypad, setShowKeypad] = useState(false);
  const barHeights = useMemo(() => [0, 1, 2, 3, 4].map(() => 12 + Math.random() * 20), []);

  // Navigate when disconnected: shadow joins skip disposition, go home
  useEffect(() => {
    if (status === 'disconnected' && callData) {
      if (callData.joined) {
        clearCallData();
        navigate('/');
      } else {
        const timer = setTimeout(() => navigate('/complete'), 500);
        return () => clearTimeout(timer);
      }
    }
  }, [status, callData, clearCallData, navigate]);

  // No call data — redirect
  useEffect(() => {
    if (!callData) navigate('/');
  }, [callData, navigate]);

  if (!callData) return null;

  const contact = callData.contact;
  const props = contact?.properties || {};
  const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || 'Unknown';

  function handleMute() {
    toggleMute();
  }

  function handleDigit(digit) {
    sendDigits(digit);
  }

  function handleEnd() {
    endCurrentCall();
  }

  const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

  return (
    <div className="flex flex-col items-center justify-between h-full py-8 px-6">
      {/* Contact info */}
      <div className="text-center">
        <div className="w-20 h-20 rounded-full bg-jv-elevated flex items-center justify-center mx-auto mb-4">
          <span className="text-3xl font-semibold text-jv-blue">
            {(props.firstname || '?')[0].toUpperCase()}
          </span>
        </div>
        <h2 className="text-xl font-semibold">{name}</h2>
        <p className="text-jv-muted">{props.company || ''}</p>
        <p className="text-sm text-jv-muted mt-1">{props.phone || props.mobilephone || ''}</p>
      </div>

      {/* Status + Timer */}
      <div className="text-center">
        <p className={`text-sm mb-2 ${status === 'connected' ? 'text-jv-green' : 'text-jv-amber'}`}>
          {STATUS_TEXT[status] || status}
        </p>
        <p className="text-4xl font-mono font-light tracking-wider">
          {formatTime(elapsed)}
        </p>

        {/* Pulsing indicator */}
        {status === 'connected' && (
          <div className="flex justify-center gap-1 mt-4">
            {barHeights.map((h, i) => (
              <div
                key={i}
                className="w-1 bg-jv-green rounded-full animate-pulse"
                style={{
                  height: `${h}px`,
                  animationDelay: `${i * 0.15}s`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Keypad */}
      {showKeypad && (
        <div className="grid grid-cols-3 gap-3 w-56">
          {DIGITS.map((d) => (
            <button
              key={d}
              onClick={() => handleDigit(d)}
              className="w-16 h-16 rounded-full bg-jv-elevated text-xl font-medium flex items-center justify-center hover:bg-jv-card transition-colors mx-auto"
            >
              {d}
            </button>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="w-full space-y-4">
        <div className="flex justify-center gap-8">
          {/* Mute */}
          <button
            onClick={handleMute}
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              muted ? 'bg-jv-red/20 text-jv-red' : 'bg-jv-elevated text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
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
            className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
              showKeypad ? 'bg-jv-blue/20 text-jv-blue' : 'bg-jv-elevated text-white'
            }`}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
            </svg>
          </button>
        </div>

        {/* End call */}
        <button
          onClick={handleEnd}
          className="w-16 h-16 rounded-full bg-jv-red flex items-center justify-center mx-auto hover:bg-red-600 transition-colors"
        >
          <svg className="w-8 h-8 text-white rotate-[135deg]" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
