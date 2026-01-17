import { useState, useEffect } from 'react';

export interface RequestStatsItem {
  key: string;
  provider: string;
  model: string;
  success: number;
  fail: number;
  lastRequest?: {
    timestamp: string;
    request: any;
    response?: any;
    error?: string;
    statusCode?: number;
  };
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
      console.error('Request stats SSE connection failed');
      es.close();
    };

    return () => es.close();
  }, []);

  return { stats, isLoading };
}
