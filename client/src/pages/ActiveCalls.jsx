import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useActiveCalls from '../hooks/useActiveCalls';
import { formatDuration } from '../lib/format';
import { getSimListenUrl } from '../lib/api';

export default function ActiveCalls({ identity, callState, twilioHook }) {
  const calls = useActiveCalls(true);
  const navigate = useNavigate();
  const [listenId, setListenId] = useState(null);
  const wsRef = useRef(null);
  const ctxRef = useRef(null);

  async function handleJoin(call, muted) {
    try {
      await callState.joinExistingCall(call.conferenceName, identity, muted);
      navigate('/dialer');
    } catch (err) {
      alert('Join failed: ' + err.message);
    }
  }

  const stopListening = useCallback(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    if (ctxRef.current) { ctxRef.current.close(); ctxRef.current = null; }
    setListenId(null);
  }, []);

  useEffect(() => () => stopListening(), [stopListening]);

  const handleListen = useCallback(async (call) => {
    if (listenId === call.simCallId) { stopListening(); return; }
    stopListening();

    try {
      const { listenUrl } = await getSimListenUrl(call.simCallId);
      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;

      const ws = new WebSocket(listenUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      setListenId(call.simCallId);

      // Buffer ~200ms of audio before scheduling to reduce choppiness
      let nextTime = ctx.currentTime + 0.2;

      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const pcm16 = new Int16Array(e.data);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
          float32[i] = pcm16[i] / 32768;
        }
        const buf = ctx.createBuffer(1, float32.length, 16000);
        buf.getChannelData(0).set(float32);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        const now = ctx.currentTime;
        if (nextTime < now) nextTime = now + 0.05;
        src.start(nextTime);
        nextTime += buf.duration;
      };

      ws.onclose = () => { setListenId(null); };
      ws.onerror = () => { stopListening(); };
    } catch (err) {
      alert('Listen failed: ' + err.message);
      stopListening();
    }
  }, [listenId, stopListening]);

  return (
    <div className="h-full overflow-y-auto scroll-container p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Live Calls</h2>
        {twilioHook.status !== 'ready' && (
          <span className="text-xs px-2 py-1 rounded bg-jv-amber/20 text-jv-amber">
            {twilioHook.status === 'error' ? '⚠ Audio device error — reload page' : '⏳ Audio device connecting...'}
          </span>
        )}
      </div>

      {calls.length === 0 && (
        <div className="text-center py-12">
          <p className="text-jv-muted text-lg mb-2">No active calls</p>
          <p className="text-sm text-jv-muted">Live and practice calls will appear here</p>
        </div>
      )}

      <div className="space-y-3">
        {calls.map((call) => (
          <div
            key={call.conferenceName}
            className="bg-jv-card border border-jv-border rounded-sentinel p-4"
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-medium">{call.leadName || 'Unknown'}</p>
                  {call.type === 'sim' && (
                    <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase rounded bg-jv-violet/20 text-jv-violet">
                      Practice
                    </span>
                  )}
                </div>
                <p className="text-sm text-jv-muted">{call.leadCompany || ''}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-jv-green">{formatDuration(call.duration)}</p>
                <p className="text-xs text-jv-muted capitalize">{call.startedBy}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <div className={`w-2 h-2 rounded-full animate-pulse ${call.type === 'sim' ? 'bg-jv-violet' : 'bg-jv-green'}`} />
              <span className="text-xs text-jv-muted">
                {call.type === 'sim'
                  ? (call.simStatus === 'scoring' ? 'Scoring…' : 'In progress')
                  : `${call.participants.length} participant${call.participants.length !== 1 ? 's' : ''}`}
              </span>
            </div>

            {call.type === 'sim' ? (
              call.hasListenUrl && call.simStatus === 'in-progress' && (
                <button
                  onClick={() => handleListen(call)}
                  className={`w-full py-2.5 rounded-sentinel text-sm font-medium transition-colors ${
                    listenId === call.simCallId
                      ? 'bg-jv-violet text-white'
                      : 'bg-jv-elevated border border-jv-border hover:bg-jv-card'
                  }`}
                >
                  {listenId === call.simCallId ? '🔊 Listening — tap to stop' : '🎧 Listen In'}
                </button>
              )
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={() => handleJoin(call, true)}
                  disabled={twilioHook.status !== 'ready'}
                  className="flex-1 py-2.5 rounded-sentinel bg-jv-elevated border border-jv-border text-sm font-medium hover:bg-jv-card transition-colors disabled:opacity-40"
                >
                  Join Silent
                </button>
                <button
                  onClick={() => handleJoin(call, false)}
                  disabled={twilioHook.status !== 'ready'}
                  className="flex-1 py-2.5 rounded-sentinel bg-jv-amber text-black text-sm font-semibold transition-colors disabled:opacity-40"
                >
                  Join Call
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
