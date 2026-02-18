import { useState, useEffect } from 'react';

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
  success: number;
  fail: number;
  lastSuccessRequest?: LastSuccessInfo;
  lastFailureRequest?: LastFailureInfo;
  /** @deprecated backward compat */
  lastRequest?: any;
}

export function useRequestStats() {
  const [stats, setStats] = useState<RequestStatsItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const es = new EventSource('/api/request-stats/stream');

    es.onopen = () => {
      setIsLoading(false);
    };

    es.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('[SSE] Received message:', message);

        if (message.type === 'initial') {
          setStats(message.data || []);
        } else if (message.type === 'update') {
          console.log('[SSE] Update stats:', message.data);
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
      console.error('Request stats SSE connection failed');
      es.close();
    };

    return () => es.close();
  }, []);

  return { stats, isLoading };
}
