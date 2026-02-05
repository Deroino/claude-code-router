import { useEffect, useRef, useCallback } from "react";
import { Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { ModelMonitorLogEntry } from "@/hooks/useModelMonitorLogs";

interface ModelMonitorPanelProps {
  logs: ModelMonitorLogEntry[];
  status: 'connecting' | 'connected' | 'error';
  currentFile: string | null;
  onClose: () => void;
  onHoverModel?: (provider: string | null, model: string | null) => void;
}

export function ModelMonitorPanel({ logs, status, currentFile, onClose, onHoverModel }: ModelMonitorPanelProps) {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when logs update
  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Handle hover on log entry
  const handleMouseEnter = useCallback((provider: string | undefined, model: string | undefined) => {
    console.log('[ModelMonitorPanel] MouseEnter:', { provider, model, hasOnHoverModel: !!onHoverModel });

    // Handle case where provider is undefined but model contains "provider,model" format
    let actualProvider = provider;
    let actualModel = model;

    if (!actualProvider && actualModel && actualModel.includes(',')) {
      const parts = actualModel.split(',');
      actualProvider = parts[0];
      actualModel = parts.slice(1).join(',');
    }

    if (onHoverModel && actualProvider && actualModel) {
      onHoverModel(actualProvider, actualModel);
    }
  }, [onHoverModel]);

  const handleMouseLeave = useCallback(() => {
    console.log('[ModelMonitorPanel] MouseLeave');
    if (onHoverModel) {
      onHoverModel(null, null);
    }
  }, [onHoverModel]);

  return (
    <div className="flex flex-col h-full rounded-md border bg-white shadow-sm overflow-hidden animate-slide-in">
      <div className="flex items-center justify-between px-4 py-3 border-b bg-gray-50/50">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-gray-500" />
          <h3 className="font-semibold text-gray-800">{t('monitor.title')}</h3>
          {status === 'connecting' && (
            <span className="text-xs font-normal text-muted-foreground animate-pulse">({t('monitor.connecting')})</span>
          )}
          {currentFile && (
            <span className="text-xs font-normal text-muted-foreground truncate max-w-[150px]" title={currentFile}>
              ({currentFile})
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-6 w-6">
          <span className="sr-only">{t('monitor.close')}</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-xs font-mono bg-gray-50/30">
        <div className="space-y-1.5">
          {logs.length === 0 ? (
            <div className="text-muted-foreground text-center py-8">{t('monitor.waiting_for_requests')}</div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className="rounded-sm border bg-white px-3 py-2 shadow-sm hover:shadow transition-all cursor-pointer"
                onMouseEnter={() => handleMouseEnter(log.provider, log.model)}
                onMouseLeave={handleMouseLeave}
              >
                <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-500">{log.timestamp}</span>
                    {log.reqId && <span className="bg-gray-100 px-1 rounded text-gray-400">#{log.reqId.slice(-4)}</span>}
                  </div>
                </div>
                <div className="break-all leading-relaxed">
                  {log.model ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                         {log.scenarioLabel && (
                           <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 text-[10px] font-medium border border-blue-100 whitespace-nowrap">
                             {log.scenarioLabel}
                           </span>
                         )}
                         <span className="font-bold text-gray-800">{log.model}</span>
                      </div>
                      {log.provider && (
                        <div className="text-gray-500 flex items-center gap-1">
                          {t('monitor.via')} <span className="font-medium text-gray-600">{log.provider}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">{log.raw}</span>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}
