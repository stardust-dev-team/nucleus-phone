import { useState, useRef, useEffect, useCallback } from 'react';
import {
  askNucleus,
  askNucleusEscalate,
  askNucleusGetConversation,
  askNucleusDeleteConversation,
} from '../lib/api';

const LS_KEY = 'nucleus_ask_conversation_id';

/**
 * Ask Nucleus chat hook — server-owned state.
 *
 * Client sends { message, conversationId }. Server fetches history from DB,
 * appends, streams response, saves. Client never sends raw history.
 * conversationId survives page reload via localStorage, verified on mount.
 */
export default function useAskNucleus() {
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [toolStatus, setToolStatus] = useState(null);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);

  // Restore conversationId from localStorage on mount, verify it still exists
  useEffect(() => {
    const stored = localStorage.getItem(LS_KEY);
    if (!stored) return;
    const id = parseInt(stored, 10);
    if (isNaN(id)) return;

    const controller = new AbortController();
    askNucleusGetConversation(id, { signal: controller.signal })
      .then((data) => {
        setConversationId(data.id);
        // Filter to user+assistant text messages, preserve escalation objects
        // so the "Send to Tom" button survives page reload. Skip _debug entries
        // from server-side DB-backed diagnostic logging.
        const cleaned = (data.messages || [])
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
            ...(m.escalation && { escalation: m.escalation }),
          }));
        setMessages(cleaned);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        // 404 or other — stale conversationId, reset
        localStorage.removeItem(LS_KEY);
      });

    return () => controller.abort();
  }, []);

  // Abort in-flight stream on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /**
   * Returns true on success, false on failure/abort. Never throws.
   * Callers can restore input state on false.
   */
  const sendMessage = useCallback(async (text) => {
    if (!text || !text.trim() || isLoading) return false;
    const trimmed = text.trim();

    setError(null);
    setIsLoading(true);
    setToolStatus(null);

    // Optimistically add user message + empty assistant placeholder
    setMessages(prev => [
      ...prev,
      { role: 'user', content: trimmed },
      { role: 'assistant', content: '', streaming: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await askNucleus({
        message: trimmed,
        conversationId,
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try { detail = await response.text(); } catch { /* noop */ }
        throw new Error(`Server error ${response.status}${detail ? `: ${detail.substring(0, 200)}` : ''}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantText = '';
      let finalEscalation = null;
      let finalConvId = conversationId;

      // Sentinel class so processLine can distinguish server errors from JSON parse errors
      class StreamError extends Error {}

      const handleEvent = (event) => {
        if (event.type === 'text_delta') {
          assistantText += event.text;
          setMessages(prev => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: assistantText };
            }
            return next;
          });
        } else if (event.type === 'tool_status') {
          setToolStatus(event.name);
        } else if (event.type === 'done') {
          finalConvId = event.conversationId;
          finalEscalation = event.escalation || null;
        } else if (event.type === 'error') {
          throw new StreamError(event.message || 'Stream error');
        }
      };

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6);
        if (!data) return;
        try {
          handleEvent(JSON.parse(data));
        } catch (err) {
          if (err instanceof StreamError) throw err;
          console.warn('Ask Nucleus: malformed SSE event', data.substring(0, 100));
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Flush any trailing partial line (defensive — server always ends with \n\n)
          if (buffer) processLine(buffer);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        // Split on \r?\n — SSE spec allows CRLF, some proxies send it
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();

        for (const line of lines) {
          processLine(line);
        }
      }

      // Finalize: update conversationId (handles auto-rotation), attach escalation
      if (finalConvId) {
        if (finalConvId !== conversationId) setConversationId(finalConvId);
        localStorage.setItem(LS_KEY, String(finalConvId));
      }

      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          next[next.length - 1] = {
            ...last,
            streaming: false,
            escalation: finalEscalation,
          };
        }
        return next;
      });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.error('Ask Nucleus send failed:', err);
      setError(err.message || 'Something went wrong');
      // Remove the optimistic user message + empty assistant placeholder on error
      // so the user can retry (handleSubmit restores their input text)
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) next.pop();
        const newLast = next[next.length - 1];
        if (newLast?.role === 'user' && newLast.content === trimmed) next.pop();
        return next;
      });
      return false;
    } finally {
      setIsLoading(false);
      setToolStatus(null);
      abortRef.current = null;
    }
  }, [conversationId, isLoading]);

  const clearHistory = useCallback(async () => {
    abortRef.current?.abort();
    const oldId = conversationId;
    setMessages([]);
    setConversationId(null);
    setError(null);
    localStorage.removeItem(LS_KEY);
    if (oldId) {
      try {
        await askNucleusDeleteConversation(oldId);
      } catch (err) {
        console.error('Failed to delete conversation:', err);
      }
    }
  }, [conversationId]);

  const escalate = useCallback(async ({ question, context, company, contact }) => {
    try {
      const result = await askNucleusEscalate({
        question,
        context: context || '',
        company,
        contact,
        conversationId,
      });
      return result;
    } catch (err) {
      console.error('Escalation failed:', err);
      throw err;
    }
  }, [conversationId]);

  return {
    messages,
    isLoading,
    toolStatus,
    error,
    conversationId,
    sendMessage,
    clearHistory,
    escalate,
  };
}
