import { useState, useEffect, useRef, useCallback } from 'react';
import Vapi from '@vapi-ai/web';
import { startPracticeCall, getPracticeCallStatus, cancelPracticeCall, linkVapiCall } from '../../lib/api';
import { GRADE_EMOJI } from '../../lib/constants';

const DIFFICULTIES = [
  { key: 'easy', label: 'Easy', desc: 'Friendly Mike — open to conversation' },
  { key: 'medium', label: 'Medium', desc: 'Skeptical Mike — pushes back on pitches' },
  { key: 'hard', label: 'Hard', desc: 'Hostile Mike — you have 30 seconds' },
];

// Phase 1: poll every 5s while call in progress (no timeout — calls can run 8 min)
// Phase 2: poll every 3s while scoring, 60s timeout
const POLL_CALL_MS = 5000;
const POLL_SCORE_MS = 3000;
const SCORE_TIMEOUT_MS = 60000;

export default function PracticeCallButton({ identity, onScoreComplete, onCallStart, onCallEnd }) {
  const [phase, setPhase] = useState('idle'); // idle | selecting | connecting | in-progress | scoring | complete | error
  const [difficulty, setDifficulty] = useState(null);
  const [callMode, setCallMode] = useState('browser'); // 'phone' | 'browser'
  const [simCallId, setSimCallId] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const pollRef = useRef(null);
  const abortRef = useRef(null);
  const startTimeRef = useRef(null);
  const vapiRef = useRef(null);
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

  const cleanup = useCallback(() => {
    cleanupPoll();
    cleanupVapi();
  }, [cleanupPoll, cleanupVapi]);

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

  async function handleStart(diff) {
    setDifficulty(diff);
    setPhase('connecting');
    setErrorMsg('');
    setResult(null);

    try {
      const data = await startPracticeCall(diff, callMode);
      setSimCallId(data.simCallId);

      const vapiPubKey = import.meta.env.VITE_VAPI_PUBLIC_KEY || data.publicKey;
      if (callMode === 'browser' && data.assistantId && vapiPubKey) {
        const vapi = new Vapi(vapiPubKey);
        vapiRef.current = vapi;
        vapi.on('call-end', () => {
          cleanupVapi();
        });
        const vapiCall = await vapi.start(data.assistantId);
        // Link the Vapi call ID BEFORE proceeding — webhooks arrive immediately
        await linkVapiCall(data.simCallId, vapiCall.id);
      }

      setPhase('in-progress');
      startTimeRef.current = Date.now();
      onCallStartRef.current?.(data.simCallId);
      startPolling(data.simCallId, 'in-progress');
    } catch (err) {
      cleanupVapi();
      setPhase('error');
      setErrorMsg(err.message);
    }
  }

  async function handleCancel() {
    const wasActive = phase === 'in-progress';
    cleanup();
    if (wasActive) onCallEndRef.current?.();
    if (simCallId) {
      try { await cancelPracticeCall(simCallId); } catch (err) { console.debug('sim cancel (best-effort):', err.message); }
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

  // ─── Idle ─────────────────────────────────────
  if (phase === 'idle') {
    return (
      <div className="flex flex-col items-center gap-2 w-full max-w-[400px] mx-auto">
        <button
          onClick={() => setPhase('selecting')}
          className="w-full py-3 rounded-lg text-[15px] font-semibold text-white flex items-center justify-center gap-2 cursor-pointer transition-opacity"
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
        <div className="flex items-center justify-center gap-1 p-0.5 rounded-lg mb-1"
          style={{ background: 'var(--cockpit-card)', border: '1px solid var(--cockpit-card-border)' }}
        >
          {[
            { key: 'browser', icon: '🔊', label: 'Browser' },
            { key: 'phone', icon: '📱', label: 'Phone' },
          ].map(m => (
            <button
              key={m.key}
              onClick={() => setCallMode(m.key)}
              className="flex-1 py-1.5 rounded-md text-[12px] font-medium cursor-pointer transition-colors"
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

        <p className="text-[13px] font-medium text-center" style={{ color: 'var(--cockpit-text-secondary)' }}>
          Choose difficulty
        </p>
        {DIFFICULTIES.map(d => (
          <button
            key={d.key}
            onClick={() => handleStart(d.key)}
            className="w-full py-2.5 px-4 rounded-lg text-left transition-colors cursor-pointer"
            style={{
              background: 'var(--cockpit-purple-bg)',
              border: '1px solid var(--cockpit-purple-border)',
            }}
          >
            <span className="text-[14px] font-semibold" style={{ color: 'var(--cockpit-purple-900)' }}>
              {d.label}
            </span>
            <span className="block text-[12px] mt-0.5" style={{ color: 'var(--cockpit-text-muted)' }}>
              {d.desc}
            </span>
          </button>
        ))}
        <button
          onClick={handleReset}
          className="text-[12px] mt-1 cursor-pointer"
          style={{ color: 'var(--cockpit-text-muted)' }}
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
          className="flex items-center gap-3 w-full px-6 py-3 rounded-lg justify-center"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full animate-pulse"
            style={{ background: 'var(--cockpit-purple-500)' }}
          />
          <span className="text-sm font-medium" style={{ color: 'var(--cockpit-purple-900)' }}>
            {phase === 'connecting'
              ? (callMode === 'browser' ? 'Connecting browser audio...' : 'Calling your phone...')
              : (callMode === 'browser' ? '🔊 Practice call — browser audio' : 'Practice call in progress')}
          </span>
        </div>
        <button
          onClick={handleCancel}
          className="text-[12px] cursor-pointer px-3 py-1 rounded"
          style={{ color: 'var(--cockpit-red-text)', background: 'var(--cockpit-red-bg)' }}
        >
          Cancel practice
        </button>
      </div>
    );
  }

  // ─── Scoring ──────────────────────────────────
  if (phase === 'scoring') {
    return (
      <div className="flex items-center gap-3 w-full max-w-[400px] mx-auto px-6 py-3 rounded-lg justify-center"
        style={{
          background: 'var(--cockpit-purple-bg)',
          border: '1px solid var(--cockpit-purple-border)',
        }}
      >
        <svg className="w-4 h-4 animate-spin" style={{ color: 'var(--cockpit-purple-500)' }} fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-sm font-medium" style={{ color: 'var(--cockpit-purple-900)' }}>
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
          className="flex items-center justify-between px-4 py-3 rounded-lg"
          style={{
            background: 'var(--cockpit-purple-bg)',
            border: '1px solid var(--cockpit-purple-border)',
          }}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">{emoji}</span>
            <div>
              <span className="text-[20px] font-bold" style={{ color: 'var(--cockpit-purple-900)' }}>
                Grade: {result.grade}
              </span>
              <span className="text-[13px] ml-2" style={{ color: 'var(--cockpit-text-muted)' }}>
                {result.score_overall}/10
              </span>
            </div>
          </div>
          {result.duration_seconds && (
            <span className="text-[12px]" style={{ color: 'var(--cockpit-text-muted)' }}>
              {Math.floor(result.duration_seconds / 60)}m {String(result.duration_seconds % 60).padStart(2, '0')}s
            </span>
          )}
        </div>

        {/* Debrief */}
        {result.caller_debrief && (
          <div
            className="px-4 py-3 rounded-lg text-[13px] leading-relaxed"
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
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'var(--cockpit-green-50)' }}
              >
                <span>💪</span>
                <span style={{ color: 'var(--cockpit-green-900)' }}>{result.top_strength}</span>
              </div>
            )}
            {result.top_improvement && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg text-[12px]"
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
          className="w-full py-2.5 rounded-lg text-[14px] font-semibold text-white cursor-pointer transition-opacity"
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
        <p className="text-[13px] px-3 py-2 rounded-lg" style={{ color: 'var(--cockpit-red-text)', background: 'var(--cockpit-red-bg)' }}>
          {errorMsg}
        </p>
        <button
          onClick={handleReset}
          className="text-[13px] cursor-pointer"
          style={{ color: 'var(--cockpit-purple-500)' }}
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}
