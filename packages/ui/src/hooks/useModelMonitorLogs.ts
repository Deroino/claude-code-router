import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';

export interface ModelMonitorLogEntry {
  id: string;
  timestamp: string;
  model?: string;
  provider?: string;
  reqId?: string;
  scenarioType?: string;
  scenarioLabel?: string;
  raw: string;
  status?: 'pending' | 'success' | 'failure';
  statusCode?: number;
  errorMessage?: string;
}

interface UseModelMonitorLogsProps {
  isOpen: boolean;
  maxItems?: number;
}

export function useModelMonitorLogs({
  isOpen,
  maxItems = 50,
}: UseModelMonitorLogsProps) {
  const [logs, setLogs] = useState<ModelMonitorLogEntry[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (isOpen) {
      // Clean up previous connection if exists
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      setStatus('connecting');
      setError(null);

      // Connect to SSE endpoint
      const es = new EventSource('/api/logs/stream');
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus('connected');
        setError(null);
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'system') {
            // Handle system messages (e.g., file rotation, connection info)
            if (data.msg?.startsWith('Watching log file:')) {
              const fileName = data.msg.split(': ')[1];
              setCurrentFile(fileName);
            }

            // Add system message to logs
            setLogs(prev => {
              const systemEntry: ModelMonitorLogEntry = {
                id: `sys-${Date.now()}`,
                timestamp: new Date().toLocaleTimeString(),
                raw: data.msg,
                reqId: 'system'
              };
              const newLogs = [...prev, systemEntry];
              return newLogs.slice(-maxItems);
            });
          } else if (data.type === 'log' && data.data) {
            // Handle log entries
            const logEntry: ModelMonitorLogEntry = {
              id: data.data.id || `log-${Date.now()}`,
              timestamp: data.data.timestamp || new Date().toLocaleTimeString(),
              model: data.data.model,
              provider: data.data.provider,
              reqId: data.data.reqId,
              scenarioType: data.data.scenarioType,
              scenarioLabel: data.data.scenarioLabel,
              raw: data.data.raw || JSON.stringify(data.data),
              status: 'pending',
            };

            setLogs(prev => {
              const newLogs = [...prev, logEntry];
              return newLogs.slice(-maxItems);
            });
          } else if (data.type === 'request_complete' && data.data) {
            // Update existing log entry status by reqId
            setLogs(prev => prev.map(log =>
              log.reqId === data.data.reqId
                ? {
                    ...log,
                    status: data.data.success ? 'success' as const : 'failure' as const,
                    statusCode: data.data.statusCode,
                    errorMessage: data.data.error,
                  }
                : log
            ));
          }
        } catch (e) {
          console.error('Error parsing SSE event:', e);
        }
      };

      es.onerror = (err) => {
        console.error('SSE Error:', err);
        setStatus('error');
        // EventSource automatically retries, but we update status
        // If the server closes the connection, we might need to handle it
        if (es.readyState === EventSource.CLOSED) {
          setError('Connection closed');
        } else {
          setError('Connection error');
        }
      };

    } else {
      // Close connection when dialog is closed
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setStatus('connecting');
      }
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [isOpen, maxItems]);

  return { logs, currentFile, status, error };
}
