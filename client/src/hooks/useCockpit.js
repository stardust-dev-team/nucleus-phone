import { useState, useEffect, useCallback, useRef } from 'react';
import { getCockpit, refreshCockpit } from '../lib/api';

export default function useCockpit(identifier, { difficulty } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const controllerRef = useRef(null);

  const fetchData = useCallback(async (refresh = false) => {
    if (!identifier) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const fetcher = refresh ? refreshCockpit : getCockpit;
      const result = await fetcher(identifier, controller.signal, { difficulty });
      setData(result);
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      if (refresh) setRefreshing(false); else setLoading(false);
    }
  }, [identifier, difficulty]);

  useEffect(() => {
    fetchData();
    return () => controllerRef.current?.abort();
  }, [fetchData]);

  const refresh = useCallback(() => fetchData(true), [fetchData]);

  return { data, loading, error, refreshing, refresh };
}
