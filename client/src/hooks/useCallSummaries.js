import { useState, useEffect, useRef, useCallback } from 'react';
import { getCallSummaries } from '../lib/api';

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 300;

export default function useCallSummaries(identity, role) {
  const [summaries, setSummaries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [caller, setCaller] = useState(identity);

  const offsetRef = useRef(0);
  const abortRef = useRef(null);
  const debounceRef = useRef(null);
  const mountedRef = useRef(false);

  const fetchSummaries = useCallback(async (opts = {}) => {
    const { append = false, q = search, callerFilter = caller } = opts;
    if (!append) {
      offsetRef.current = 0;
      setLoading(true);
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const data = await getCallSummaries({
        caller: callerFilter || undefined,
        q: q || undefined,
        limit: PAGE_SIZE,
        offset: append ? offsetRef.current : 0,
        signal: controller.signal,
      });

      if (append) {
        setSummaries(prev => [...prev, ...data.summaries]);
      } else {
        setSummaries(data.summaries);
      }
      setTotal(data.total);
      offsetRef.current = (append ? offsetRef.current : 0) + data.summaries.length;
      setError(null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError('Failed to load summaries');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [search, caller]);

  // Initial fetch + refetch on caller change
  useEffect(() => {
    fetchSummaries();
    mountedRef.current = true;
    return () => abortRef.current?.abort();
  }, [caller]);

  // Debounced search — skip initial mount (caller effect handles it)
  useEffect(() => {
    if (!mountedRef.current) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSummaries({ q: search });
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const loadMore = useCallback(() => {
    if (offsetRef.current < total) {
      fetchSummaries({ append: true });
    }
  }, [total, fetchSummaries]);

  const hasMore = offsetRef.current < total;

  return {
    summaries,
    total,
    loading,
    error,
    search,
    setSearch,
    caller,
    setCaller: role === 'admin' ? setCaller : undefined,
    loadMore,
    hasMore,
    refresh: () => fetchSummaries(),
  };
}
