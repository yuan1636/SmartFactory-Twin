/**
 * REST 轮询（G-11 / 7.3）。
 * 三条硬约束：页面不可见时暂停、同一资源同时只允许一个在途请求、key 变化立即重取。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  options: { enabled?: boolean; key?: string } = {},
): PollingState<T> {
  const { enabled = true, key = '' } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const inFlight = useRef(false);
  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetcherRef.current();
      if (!alive.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (!alive.current) return;
      setError(e);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading((prev) => (prev ? prev : true));
    void run();

    const timer = setInterval(() => {
      if (document.hidden) return; // 页面不可见时暂停，可见时下面的监听会立即补一次
      void run();
    }, intervalMs);

    const onVisible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, key, run]);

  return { data, error, loading, updatedAt, refresh: run };
}
