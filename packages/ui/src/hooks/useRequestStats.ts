import { useState, useEffect, useRef, useCallback } from 'react';

export interface LastSuccessInfo {
  timestamp: string;
  request: any;
  response: any;
}

export interface LastFailureInfo {
  timestamp: string;
  request: any;
  error: string;
  statusCode?: number;
}

export interface RequestStatsItem {
  key: string;
  provider: string;
  model: string;
  keyIndex?: number;  // Present for per-key entries (format: provider:#N:model)
  success: number;
  fail: number;
  lastSuccessRequest?: LastSuccessInfo;
  lastFailureRequest?: LastFailureInfo;
  /** @deprecated backward compat */
  lastRequest?: any;
}

const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;

export function useRequestStats() {
  const [stats, setStats] = useState<RequestStatsItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const unmountedRef = useRef(false);
  const prefetchedRef = useRef(false);

  // Pre-fetch stats via REST API for immediate first render
  const prefetchStats = useCallback(async () => {
    if (prefetchedRef.current) return;
    prefetchedRef.current = true;
    try {
      const res = await fetch('/api/request-stats');
      if (res.ok) {
        const data = await res.json();
        if (!unmountedRef.current && Array.isArray(data.stats)) {
          setStats(data.stats);
          setIsLoading(false);
        }
      }
    } catch {
      // Silently fail — SSE will provide data as fallback
    }
  }, []);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    // Clean up previous connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource('/api/request-stats/stream');
    esRef.current = es;

    es.onopen = () => {
      setIsLoading(false);
      retriesRef.current = 0; // Reset retry count on successful connection
    };

    es.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'initial') {
          setStats(message.data || []);
        } else if (message.type === 'update') {
          setStats(prev => {
            const index = prev.findIndex(s => s.key === message.data.key);
            if (index >= 0) {
              const updated = [...prev];
              updated[index] = message.data;
              return updated;
            }
            return [...prev, message.data];
          });
        } else if (message.type === 'clear') {
          setStats([]);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    es.onerror = () => {
      setIsLoading(false);
      es.close();
      esRef.current = null;

      if (unmountedRef.current) return;

      // Exponential backoff reconnection
      const delay = Math.min(
        BASE_RECONNECT_DELAY * Math.pow(2, retriesRef.current),
        MAX_RECONNECT_DELAY
      );
      retriesRef.current += 1;
      console.warn(`[SSE] Connection lost, reconnecting in ${delay}ms (attempt ${retriesRef.current})...`);

      reconnectTimerRef.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    // Pre-fetch via REST for immediate data, then establish SSE for live updates
    prefetchStats();
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect, prefetchStats]);

  return { stats, isLoading };
}
