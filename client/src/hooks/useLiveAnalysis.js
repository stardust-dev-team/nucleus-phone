import { useState, useEffect, useRef, useCallback } from 'react';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

export default function useLiveAnalysis(callId, enabled = true) {
  const [equipment, setEquipment] = useState([]);
  const [sizing, setSizing] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef(null);
  const callIdRef = useRef(callId);
  callIdRef.current = callId;

  const seenRef = useRef(new Set());

  const reset = useCallback(() => {
    setEquipment([]);
    setSizing(null);
    setRecommendation(null);
    seenRef.current.clear();
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
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'equipment_detected' && msg.data) {
          const key = `${msg.data.manufacturer}:${msg.data.model}`;
          if (!seenRef.current.has(key)) {
            seenRef.current.add(key);
            setEquipment(prev => [...prev, msg.data]);
          }
        } else if (msg.type === 'sizing_updated' && msg.data) {
          setSizing(msg.data);
        } else if (msg.type === 'recommendation_ready' && msg.data) {
          setRecommendation(msg.data);
        }
      };

      ws.onclose = (event) => {
        setConnected(false);
        wsRef.current = null;

        // Don't retry on intentional close or max retries exceeded
        if (event.code === 1000 || retriesRef.current >= MAX_RETRIES) return;

        retriesRef.current++;
        retryTimerRef.current = setTimeout(connect, RETRY_DELAY_MS);
      };

      ws.onerror = () => {
        // onclose fires after onerror — reconnect logic lives there
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

  return { equipment, sizing, recommendation, connected };
}
