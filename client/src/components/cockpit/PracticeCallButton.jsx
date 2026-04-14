import { useState, useEffect, useRef, useCallback } from 'react';
import Vapi from '@vapi-ai/web';
import { startPracticeCall, getPracticeCallStatus, cancelPracticeCall, linkVapiCall } from '../../lib/api';
import { GRADE_EMOJI } from '../../lib/constants';

const DIFFICULTIES = [
  { key: 'easy', label: 'Easy', desc: 'Friendly Mike — open to conversation', tip: 'Mike is friendly. Focus on building rapport and asking open questions.' },
  { key: 'medium', label: 'Medium', desc: 'Skeptical Mike — pushes back on pitches', tip: 'Mike will push back. Listen to his objections before countering.' },
  { key: 'hard', label: 'Hard', desc: 'Hostile Mike — you have 30 seconds', tip: 'Mike is hostile. Lead with value, not introductions. Every second counts.' },
];

const RING_DURATION_MS = 3000;

// Phase 1: poll every 5s while call in progress (no timeout — calls can run 8 min)
// Phase 2: poll every 3s while scoring, 60s timeout
const POLL_CALL_MS = 5000;
const POLL_SCORE_MS = 3000;
const SCORE_TIMEOUT_MS = 60000;

// Synthesize a phone ringtone using Web Audio API — 0.8s burst / 0.4s gap
function playRingtone(durationMs) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const gain = ctx.createGain();
  gain.gain.value = 0.15;
  gain.connect(ctx.destination);

  const ringOn = 0.8;
  const ringOff = 0.4;
  const cycle = ringOn + ringOff;
  const cycles = Math.ceil(durationMs / 1000 / cycle);

  for (let i = 0; i < cycles; i++) {
    const start = i * cycle;
    [440, 480].forEach(freq => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + ringOn);
    });
  }

  let closed = false;
  return {
    stop: () => {
      if (closed) return;
      closed = true;
      gain.gain.value = 0;
      ctx.close().catch(() => {});
    },
  };
}

export default function PracticeCallButton({ identity, onScoreComplete, onDifficultySelect, onCallStart, onCallEnd }) {
  const [phase, setPhase] = useState('idle'); // idle | selecting | confirming | ringing | connecting | in-progress | scoring | complete | error
  const [difficulty, setDifficulty] = useState(null);
  const [callMode, setCallMode] = useState('browser'); // 'phone' | 'browser'
  const [simCallId, setSimCallId] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef(null);
  const abortRef = useRef(null);
  const startTimeRef = useRef(null);
  const vapiRef = useRef(null);
  const ringtoneRef = useRef(null);
  const ringTimerRef = useRef(null);
  const onScoreCompleteRef = useRef(onScoreComplete);
  onScoreCompleteRef.current = onScoreComplete;
  const onCallStartRef = useRef(onCallStart);
  onCallStartRef.current = onCallStart;
  const onCallEndRef = useRef(onCallEnd);
  onCallEndRef.current = onCallEnd;

  const cleanupVapi = useCallback(() => {
    if (vapiRef.current) {
      vapiRef.current.stop();
      vapiRef.current = null;
    }
  }, []);

  const cleanupPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cleanupRingtone = useCallback(() => {
    if (ringtoneRef.current) {
      ringtoneRef.current.stop();
      ringtoneRef.current = null;
    }
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    cleanupPoll();
    cleanupVapi();
    cleanupRingtone();
  }, [cleanupPoll, cleanupVapi, cleanupRingtone]);

  useEffect(() => cleanup, [cleanup]);

  function startPolling(id, expectedPhase) {
    cleanupPoll();
    const interval = expectedPhase === 'in-progress' ? POLL_CALL_MS : POLL_SCORE_MS;
    abortRef.current = new AbortController();

    pollRef.current = setInterval(async () => {
      try {
        const data = await getPracticeCallStatus(id, abortRef.current?.signal);

        if (expectedPhase === 'in-progress' && data.status !== 'in-progress') {
          cleanupPoll();
          cleanupVapi();
          onCallEndRef.current?.();
          if (data.status === 'scoring') {
            setPhase('scoring');
            startTimeRef.current = Date.now();
            startPolling(id, 'scoring');
          } else if (data.status === 'scored') {
            setPhase('complete');
            setResult(data);
            onScoreCompleteRef.current?.();
          } else if (data.status === 'cancelled') {
            setPhase('idle');
          } else {
            setPhase('error');
            setErrorMsg('Scoring failed — ask an admin to rescore');
          }
          return;
        }

        if (expectedPhase === 'scoring' && data.status !== 'scoring') {
          cleanupPoll();
          if (data.status === 'scored') {
            setPhase('complete');
            setResult(data);
            onScoreCompleteRef.current?.();
          } else {
            setPhase('error');
            setErrorMsg('Scoring failed — ask an admin to rescore');
          }
          return;
        }

        // Scoring timeout — 60s is generous, something is stuck
        if (expectedPhase === 'scoring' && Date.now() - startTimeRef.current > SCORE_TIMEOUT_MS) {
          cleanupPoll();
          setPhase('error');
          setErrorMsg('Scoring is taking longer than expected — check back soon');
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.debug('sim poll error (will retry):', err.message);
      }
    }, interval);
  }

  function handleSelectDifficulty(diff) {
    setDifficulty(diff);
    onDifficultySelect?.(diff);
    setPhase('confirming');
  }

  function handleConfirm() {
    if (phase !== 'confirming') return; // double-click guard
    setPhase('ringing');
    setErrorMsg('');
    setResult(null);

    // Play ringtone, then connect
    ringtoneRef.current = playRingtone(RING_DURATION_MS);
    ringTimerRef.current = setTimeout(() => {
      cleanupRingtone();
      initiateCall(difficulty);
    }, RING_DURATION_MS);
  }

  async function initiateCall(diff) {
    setPhase('connecting');
    let createdSimCallId = null;

    try {
      const data = await startPracticeCall(diff, callMode);
      createdSimCallId = data.simCallId;
      setSimCallId(data.simCallId);

      const vapiPubKey = import.meta.env.VITE_VAPI_PUBLIC_KEY || data.publicKey;
      if (callMode === 'browser' && data.assistantId && vapiPubKey) {
        const vapi = new Vapi(vapiPubKey);
        vapiRef.current = vapi;
        vapi.on('call-end', () => {
          cleanupVapi();
        });
        // Capture Vapi SDK errors — start() returns null on failure instead of throwing
        let vapiError = null;
        vapi.on('error', (e) => { vapiError = e; });
        const overrides = data.firstMessage ? { firstMessage: data.firstMessage } : {};
        const vapiCall = await vapi.start(data.assistantId, overrides);
        if (!vapiCall) {
          const detail = vapiError?.error?.message || vapiError?.error || 'Vapi call failed to start — check mic permissions and try again';
          throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
        }
        // Link the Vapi call ID BEFORE proceeding — webhooks arrive immediately
        await linkVapiCall(data.simCallId, vapiCall.id);
      }

      setPhase('in-progress');
      startTimeRef.current = Date.now();
      onCallStartRef.current?.(data.simCallId);
      startPolling(data.simCallId, 'in-progress');
    } catch (err) {
      cleanupVapi();
      // Cancel the stuck DB row so the 10-min guard doesn't lock us out
      if (createdSimCallId) cancelPracticeCall(createdSimCallId).catch(e => console.warn('sim: failed to cancel stuck row:', e.message));
      setPhase('error');
      setErrorMsg(err.message || 'Call failed to connect');
    }
  }

  async function handleCancel() {
    const hadActiveCall = phase === 'in-progress' || phase === 'connecting';
    cleanup();
    if (hadActiveCall) onCallEndRef.current?.();
    if (simCallId) {
      try {
        const result = await cancelPracticeCall(simCallId);
        if (result.scoring) {
          // Server has a transcript and is scoring — show scoring UI
          setPhase('scoring');
          startTimeRef.current = Date.now();
          startPolling(simCallId, 'scoring');
          return;
        }
      } catch (err) { console.debug('sim cancel (best-effort):', err.message); }
    }
    setPhase('idle');
  }

  function handleReset() {
    setPhase('idle');
    setResult(null);
    setDifficulty(null);
    setSimCallId(null);
    setErrorMsg('');
  }

  const selectedDiff = DIFFICULTIES.find(d => d.key === difficulty);

  // ─── Idle ─────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="flex flex-col items-center gap-2 w-full max-w-[400px] mx-auto">
        <button
          onClick={() => setPhase('selecting')}
          className="w-full py-3 rounded text-sm font-semibold text-white flex items-center justify-center gap-2 cursor-pointer transition-opacity"
          style={{ background: 'var(--cockpit-purple-600)' }}
        >
          🎯 Practice Call
        </button>
      </div>
    );
  }

  // ─── Difficulty selector ──────────────────────
  if (phase === 'selecting') {
    return (
      <div className="flex flex-col gap-2 w-full max-w-[400px] mx-auto">
        {/* Mode toggle */}
        <div className="flex items-center justify-center gap-1 p-0.5 rounded mb-1"
          style={{ background: 'var(--cockpit-card)', border: '1px solid var(--cockpit-card-border)' }}
        >
          {[
            { key: 'browser', icon: '🔊', label: 'Browser' },
            { key: 'phone', icon: '📱', label: 'Phone' },
          ].map(m => (
            <button
              key={m.key}
              onClick={() => setCallMode(m.key)}
              className="flex-1 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors"
              style={{
                background: callMode === m.key ? 'var(--cockpit-purple-bg)' : 'transparent',
                color: callMode === m.key ? 'var(--cockpit-purple-900)' : 'var(--cockpit-text-muted)',
                border: callMode === m.key ? '1px solid var(--cockpit-purple-border)' : '1px solid transparent',
              }}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        <p className="text-sm font-normal text-center" style={{ color: 'var(--cockpit-text-secondary)' }}>
          Choose difficulty
        </p>
        {DIFFICULTIES.map(d => (
          <button
            key={d.key}
            onClick={() => handleSelectDifficulty(d.key)}
            className="w-full py-2.5 px-4 rounded text-left transition-colors cursor-pointer"
            style={{
              background: 'var(--cockpit-purple-bg)',
              border: '1px solid var(--cockpit-purple-border)',
            }}
          >
            <span className="text-sm font-semibold" style={{ color: 'var(--cockpit-purple-900)' }}>
              {d.label}
            </span>
            <span className="block text-xs mt-0.5" style={{ color: 'var(--cockpit-text-muted)' }}>
              {d.desc}
            </span>
          </button>
        ))}
        <button
          onClick={handleReset}
          className="text-xs mt-1 cursor-pointer"
          style={{ color: 'var(--cockpit-text-muted)' }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ─── Confirmation ─────────────────────────────
  if (phase === 'confirming' && selectedDiff) {
    return (
      <div className="flex flex-col gap-3 w-full max-w-[400px] mx-auto">
        <div
          className="px-5 py-4 rounded text-center"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <p className="text-sm font-semibold" style={{ color: 'var(--cockpit-purple-900)' }}>
            {selectedDiff.label} — {selectedDiff.desc}
          </p>
          <p className="text-xs mt-2 leading-relaxed" style={{ color: 'var(--cockpit-text-muted)' }}>
            {selectedDiff.tip}
          </p>
        </div>
        <button
          onClick={handleConfirm}
          className="w-full py-3 rounded text-sm font-semibold text-white cursor-pointer transition-opacity flex items-center justify-center gap-2"
          style={{ background: 'var(--cockpit-purple-600)' }}
        >
          📞 Begin Practice Call
        </button>
        <button
          onClick={() => setPhase('selecting')}
          className="text-xs cursor-pointer"
          style={{ color: 'var(--cockpit-text-muted)' }}
        >
          Back
        </button>
      </div>
    );
  }

  // ─── Ringing ──────────────────────────────────
  if (phase === 'ringing') {
    return (
      <div className="flex flex-col items-center gap-3 w-full max-w-[400px] mx-auto">
        <div
          className="flex items-center gap-3 w-full px-6 py-4 rounded justify-center"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <span className="text-lg animate-pulse">📞</span>
          <span className="text-sm font-normal" style={{ color: 'var(--cockpit-purple-900)' }}>
            Ringing Mike Garza...
          </span>
        </div>
        <button
          onClick={handleCancel}
          className="text-xs cursor-pointer px-3 py-1 rounded"
          style={{ color: 'var(--cockpit-red-text)', background: 'var(--cockpit-red-bg)' }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // ─── Connecting / In-progress ─────────────────
  if (phase === 'connecting' || phase === 'in-progress') {
    return (
      <div className="flex flex-col items-center gap-3 w-full max-w-[400px] mx-auto">
        <div
          className="flex items-center gap-3 w-full px-6 py-3 rounded justify-center"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full animate-pulse"
            style={{ background: 'var(--cockpit-purple-500)' }}
          />
          <span className="text-sm font-normal" style={{ color: 'var(--cockpit-purple-900)' }}>
            {phase === 'connecting'
              ? (callMode === 'browser' ? 'Connecting browser audio...' : 'Calling your phone...')
              : (callMode === 'browser' ? '🔊 Practice call — browser audio' : 'Practice call in progress')}
          </span>
        </div>
        <button
          onClick={handleCancel}
          className="w-full py-2.5 rounded text-sm font-semibold cursor-pointer transition-opacity"
          style={{ color: 'var(--cockpit-red-text)', background: 'var(--cockpit-red-bg)', border: '1px solid var(--cockpit-red-border, transparent)' }}
        >
          End Practice Call
        </button>
      </div>
    );
  }

  // ─── Scoring ──────────────────────────────────
  if (phase === 'scoring') {
    return (
      <div className="flex items-center gap-3 w-full max-w-[400px] mx-auto px-6 py-3 rounded justify-center"
        style={{
          background: 'var(--cockpit-purple-bg)',
          border: '1px solid var(--cockpit-purple-border)',
        }}
      >
        <svg className="w-4 h-4 animate-spin" style={{ color: 'var(--cockpit-purple-500)' }} fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm font-normal" style={{ color: 'var(--cockpit-purple-900)' }}>
          Scoring your call...
        </span>
      </div>
    );
  }

  // ─── Complete — Full debrief ──────────────────
  if (phase === 'complete' && result) {
    const emoji = GRADE_EMOJI[result.grade] || '🎯';
    return (
      <div className="flex flex-col gap-3 w-full max-w-[440px] mx-auto">
        {/* Grade header */}
        <div
          className="flex items-center justify-between px-4 py-3 rounded"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">{emoji}</span>
            <div>
              <span className="text-lg font-semibold" style={{ color: 'var(--cockpit-purple-900)' }}>
                Grade: {result.grade}
              </span>
              <span className="text-sm ml-2" style={{ color: 'var(--cockpit-text-muted)' }}>
                {result.score_overall}/10
              </span>
            </div>
          </div>
          {result.duration_seconds && (
            <span className="text-xs" style={{ color: 'var(--cockpit-text-muted)' }}>
              {Math.floor(result.duration_seconds / 60)}m {String(result.duration_seconds % 60).padStart(2, '0')}s
            </span>
          )}
        </div>

        {/* Debrief */}
        {result.caller_debrief && (
          <div
            className="px-4 py-3 rounded text-sm leading-relaxed"
            style={{
              background: 'var(--cockpit-card)',
              border: '1px solid var(--cockpit-card-border)',
              color: 'var(--cockpit-text)',
            }}
          >
            {result.caller_debrief}
          </div>
        )}

        {/* Strength + improvement pills */}
        {(result.top_strength || result.top_improvement) && (
          <div className="flex flex-col gap-1.5">
            {result.top_strength && (
              <div className="flex items-start gap-2 px-3 py-2 rounded text-xs"
                style={{ background: 'var(--cockpit-green-50)' }}
              >
                <span>💪</span>
                <span style={{ color: 'var(--cockpit-green-900)' }}>{result.top_strength}</span>
              </div>
            )}
            {result.top_improvement && (
              <div className="flex items-start gap-2 px-3 py-2 rounded text-xs"
                style={{ background: 'var(--cockpit-amber-50)' }}
              >
                <span>🎯</span>
                <span style={{ color: 'var(--cockpit-amber-900)' }}>{result.top_improvement}</span>
              </div>
            )}
          </div>
        )}

        {/* Practice again */}
        <button
          onClick={handleReset}
          className="w-full py-2.5 rounded text-sm font-semibold text-white cursor-pointer transition-opacity"
          style={{ background: 'var(--cockpit-purple-600)' }}
        >
          Practice again
        </button>
      </div>
    );
  }

  // ─── Error ────────────────────────────────────
  if (phase === 'error') {
    return (
      <div className="flex flex-col items-center gap-2 w-full max-w-[400px] mx-auto">
        <p className="text-sm px-3 py-2 rounded" style={{ color: 'var(--cockpit-red-text)', background: 'var(--cockpit-red-bg)' }}>
          {errorMsg}
        </p>
        <button
          onClick={handleReset}
          className="text-sm cursor-pointer"
          style={{ color: 'var(--cockpit-purple-500)' }}
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}
