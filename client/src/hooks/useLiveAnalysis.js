import { useState, useEffect, useRef, useCallback } from 'react';
import { SENTIMENT_HISTORY_MAX } from '../components/cockpit/navigator-constants';

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 3000;

/**
 * Normalize a string for Tier 0 prediction matching.
 *
 * - Lowercase.
 * - Collapse all whitespace runs (incl. tabs, line breaks, double-spaces from
 *   ASR) into single spaces.
 * - Strip leading/trailing whitespace.
 * - Replace common word-boundary punctuation (`-`, `.`, `,`, `'`, `"`, `?`,
 *   `!`, `;`, `:`, `()`, `[]`) with spaces, then re-collapse spaces. This
 *   lets `how-much` match `how much`, `it's` match `its`, etc.
 *
 * Exported for unit testing — see __tests__/useLiveAnalysis.test.js (ioy).
 */
export function normalizeForPredictionMatch(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[-.,'"?!;:()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge a sentiment_update WS payload with the prior sentiment state.
 *
 * Contract: backend always sends `history[]` today, but bare {customer,
 * momentum} pings used to blank the sparkline because we reset history to [].
 * Preserve prior history when the server omits it; truncate to the render
 * window when provided.
 *
 * Exported for unit testing — see __tests__/useLiveAnalysis.test.js (u0r).
 */
export function mergeSentimentUpdate(prev, data) {
  if (!data) return prev;
  const history = Array.isArray(data.history)
    ? data.history.slice(-SENTIMENT_HISTORY_MAX)
    : (prev?.history || []);
  return { ...data, history };
}

export default function useLiveAnalysis(callId, enabled = true) {
  // Equipment detection (existing)
  const [equipment, setEquipment] = useState([]);
  const [sizing, setSizing] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [connected, setConnected] = useState(false);

  // Conversation Navigator state
  const [phase, setPhase] = useState(null);                 // { phase, key_topic }
  const [sentiment, setSentiment] = useState(null);         // { customer, momentum, history[] }
  const [suggestionHistory, setSuggestionHistory] = useState([]); // last 5 suggestions
  const [objection, setObjection] = useState(null);         // { objection, rebuttal }
  const [navigatorStatus, setNavigatorStatus] = useState('ok');

  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef(null);
  const callIdRef = useRef(callId);
  callIdRef.current = callId;

  const seenRef = useRef(new Set());
  const suggestionSeqRef = useRef(0);

  // Navigator refs — mutated by WS messages without triggering re-renders.
  // The `transcript_chunk` handler reads `.current` to do Tier 0 matching.
  const predictionRef = useRef(null);    // { pattern, suggestion }
  // NOTE: phase_bank_loaded / Tier 1 phrase matching lives in a separate bead
  // (nucleus-phone-cas). This hook does not store or consume phase banks yet.

  const reset = useCallback(() => {
    setEquipment([]);
    setSizing(null);
    setRecommendation(null);
    setPhase(null);
    setSentiment(null);
    setSuggestionHistory([]);
    setObjection(null);
    setNavigatorStatus('ok');
    seenRef.current.clear();
    predictionRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !callId) {
      if (wsRef.current) {
        wsRef.current.close(1000, 'disabled');
        wsRef.current = null;
      }
      clearTimeout(retryTimerRef.current);
      setConnected(false);
      reset();
      retriesRef.current = 0;
      return;
    }

    // Reset state when callId changes
    reset();
    retriesRef.current = 0;

    function connect() {
      if (wsRef.current) {
        wsRef.current.close(1000, 'reconnecting');
        wsRef.current = null;
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/api/live-analysis`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retriesRef.current = 0;
        ws.send(JSON.stringify({ type: 'subscribe', callId: callIdRef.current }));
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.debug('live-analysis: malformed message:', err.message);
          return;
        }

        switch (msg.type) {
          case 'equipment_detected': {
            if (!msg.data) return;
            // Dedup by manufacturer:model. Server already deduplicates — this
            // is a client-side safety net.
            const key = `${msg.data.manufacturer}:${msg.data.model}`;
            if (!seenRef.current.has(key)) {
              seenRef.current.add(key);
              setEquipment(prev => [...prev, msg.data]);
            }
            return;
          }
          case 'sizing_updated':
            if (msg.data) setSizing(msg.data);
            return;
          case 'recommendation_ready':
            if (msg.data) setRecommendation(msg.data);
            return;

          // ── Conversation Navigator messages ────────────────────────────
          case 'conversation_phase':
            if (msg.data) setPhase(msg.data);
            return;
          case 'sentiment_update': {
            if (!msg.data) return;
            // Server owns history. mergeSentimentUpdate preserves prior history
            // when the server omits it (nucleus-phone-u0r defends against
            // contract drift; today the server always sends history).
            setSentiment(prev => mergeSentimentUpdate(prev, msg.data));
            return;
          }
          case 'response_suggestion':
            if (msg.data) {
              const entry = { ...msg.data, _seq: ++suggestionSeqRef.current };
              setSuggestionHistory(prev => [...prev.slice(-4), entry]);
            }
            return;
          case 'objection_detected':
            if (msg.data) setObjection(msg.data);
            return;
          case 'prediction_loaded':
            // Replace entirely (null allowed) — prevents stale cross-cycle matches
            predictionRef.current = msg.data || null;
            return;
          case 'navigator_status':
            if (msg.data?.status) setNavigatorStatus(msg.data.status);
            return;

          // ── Tier 0: client-side prediction matching ────────────────────
          case 'transcript_chunk': {
            const text = msg.data?.text;
            const pred = predictionRef.current;
            // Normalize both sides so ASR whitespace artifacts ("how  much")
            // and punctuation variants ("how-much", "it's") still match
            // author-written patterns. Empty-pattern guard avoids
            // `"".includes("")` → true on every chunk.
            const pattern = normalizeForPredictionMatch(pred?.pattern || '');
            const haystack = normalizeForPredictionMatch(text || '');
            if (haystack && pattern && pred?.suggestion) {
              if (haystack.includes(pattern)) {
                const entry = {
                  ...pred.suggestion,
                  source: 'prediction',
                  _seq: ++suggestionSeqRef.current,
                };
                setSuggestionHistory(prev => [...prev.slice(-4), entry]);
                predictionRef.current = null; // consume — don't re-match
              }
            }
            return;
          }

          default:
            return;
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        wsRef.current = null;

        // Intentional close (code 1000) skips retry. Load-bearing: callId
        // changes close with 1000 before the retry timer fires, preventing
        // reconnect to the old callId.
        if (event.code === 1000 || retriesRef.current >= MAX_RETRIES) return;

        retriesRef.current++;
        const delay = RETRY_BASE_MS * retriesRef.current;
        retryTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose fires after onerror — reconnect logic lives there.
        console.debug('live-analysis: WebSocket error');
      };
    }

    connect();

    return () => {
      clearTimeout(retryTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close(1000, 'cleanup');
        wsRef.current = null;
      }
      setConnected(false);
    };
  }, [callId, enabled, reset]);

  return {
    equipment, sizing, recommendation, connected,
    phase, sentiment, suggestionHistory, objection, navigatorStatus,
  };
}
