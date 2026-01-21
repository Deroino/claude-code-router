import { Pencil, Trash2, Zap, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Provider } from "@/types";
import type { RequestStatsItem } from "@/hooks/useRequestStats";
import { useState, useRef, useEffect } from "react";

interface ProviderListProps {
  providers: Provider[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
  showToast: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  removeToast: (id: string) => void;
  requestStats?: RequestStatsItem[];
  testPrompt?: string;
  hoveredModel?: { provider: string | null; model: string | null } | null;
  onBadgeRef?: (provider: string, model: string, ref: HTMLDivElement | null) => void;
}

interface ModelBadgeProps {
  providerName: string;
  model: string;
  showToast: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  removeToast: (id: string) => void;
  requestStats?: RequestStatsItem[];
  testPrompt?: string;
  isHovered?: boolean;
  onBadgeRef?: (ref: HTMLDivElement | null) => void;
}

function ModelBadge({ providerName, model, showToast, removeToast, requestStats, testPrompt, isHovered, onBadgeRef }: ModelBadgeProps) {
  const [isTesting, setIsTesting] = useState(false);
  const badgeRef = useRef<HTMLDivElement>(null);

  // Register badge ref when component mounts
  useEffect(() => {
    if (onBadgeRef) {
      onBadgeRef(badgeRef.current);
    }
  }, [onBadgeRef, providerName, model]);

  // Find stats for current provider:model
  const stats = requestStats?.find(s => s.provider === providerName && s.model === model);
  const successCount = stats?.success || 0;
  const failCount = stats?.fail || 0;
  const lastRequest = stats?.lastRequest;

  const handleCopy = async () => {
    const textToCopy = `${providerName},${model}`;
    try {
      await navigator.clipboard.writeText(textToCopy);
      showToast(`"${textToCopy}" copied to clipboard!`, 'success');
    } catch (err) {
      console.error('Failed to copy text: ', err);
      showToast('Failed to copy to clipboard.', 'error');
    }
  };

  const handleCopyContent = async (content: any, label: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    try {
      await navigator.clipboard.writeText(textToCopy);
      showToast(`${label} copied to clipboard!`, 'success');
    } catch (err) {
      console.error('Failed to copy text: ', err);
      showToast('Failed to copy to clipboard.', 'error');
    }
  };

  const handleTest = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTesting) return;

    setIsTesting(true);
    const textToTest = `${providerName},${model}`;
    const toastId = showToast(`Testing ${textToTest}...`, 'warning', 0);

    try {
      const result = await api.testModel(providerName, model || "", testPrompt);
      removeToast(toastId);

      if (result?.success && result?.response) {
        showToast(`"${textToTest}" test OK\nResponse: ${result.response}`, 'success', 8000);
      } else if (result?.success) {
        showToast(`"${textToTest}" test OK`, 'success');
      } else {
        // Display error message from backend response
        const errorMsg = result?.error || 'Unknown error';
        showToast(`"${textToTest}" test failed: ${errorMsg}`, 'error', 5000);
      }
    } catch (err) {
      console.error('Model test failed: ', err);
      removeToast(toastId);

      let detail = 'Unknown error';
      if (err && typeof err === 'object') {
        const anyErr = err as { body?: string; message?: string; cause?: string; statusText?: string };
        // Check for enhanced network error details
        if (anyErr.body) {
          try {
            const parsed = JSON.parse(anyErr.body);
            // If it's a structured error with reasons, format it nicely
            if (parsed.reasons && Array.isArray(parsed.reasons)) {
              detail = `${parsed.message}\n${parsed.reasons.map((r: string) => `• ${r}`).join('\n')}`;
            } else {
              detail = parsed?.error?.message || parsed?.message || anyErr.body;
            }
          } catch {
            detail = anyErr.body;
          }
        } else if (anyErr.cause) {
          detail = anyErr.cause;
        } else if (anyErr.message) {
          detail = anyErr.message;
        }
      }
      showToast(`"${textToTest}" test failed: ${detail}`, 'error', 5000);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Badge
      ref={badgeRef}
      variant="outline"
      className={`flex flex-col items-stretch h-auto py-1 px-2 gap-0.5 transition-all duration-200 hover:scale-105 cursor-pointer bg-white hover:bg-gray-50/80 shadow-sm hover:shadow border-gray-200 w-fit max-w-full ${isHovered ? 'ring-2 ring-blue-500 ring-offset-2 bg-blue-50 border-blue-300' : ''}`}
      onClick={handleCopy}
    >
      {/* First Row: Model Name + Test Button */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-100 pb-0.5 border-dashed">
        <span className="font-medium text-gray-700 text-xs break-all" title={model}>
          {model || "Unnamed Model"}
        </span>
        <span
          className={`p-0.5 rounded-full hover:bg-gray-100 transition-colors flex-shrink-0 ${isTesting ? 'animate-pulse' : ''}`}
          title="Test availability"
          onClick={handleTest}
        >
          <Zap className={`h-3 w-3 ${isTesting ? 'text-gray-400' : 'text-amber-500 fill-amber-500'}`} />
        </span>
      </div>

      {/* Second Row: Stats (with hover tooltip) */}
      <div className="flex items-center w-full text-[9px] leading-none font-medium text-gray-400">
        {/* Success Count */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex-1 flex justify-center items-center cursor-help hover:bg-green-50 transition-colors rounded">
              <span className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm">
                <Check className="h-2.5 w-2.5 text-emerald-500" />
                <span className="text-emerald-600">{successCount}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-2xl max-h-[500px] overflow-y-auto z-[99999] bg-white/95 backdrop-blur-sm border border-gray-200 shadow-2xl text-gray-900">
            <div className="space-y-2">
              <div className="font-semibold text-sm text-gray-900">Last Successful Request</div>
              {lastRequest && !lastRequest.error ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-600">
                    Timestamp: {new Date(lastRequest.timestamp).toLocaleString()}
                  </div>
                  <div>
                    <div className="font-semibold text-xs mb-1 text-gray-900">Request:</div>
                    <pre
                      className="bg-gray-50 border border-gray-200 p-2 rounded text-xs overflow-auto max-h-32 text-gray-900 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={(e) => handleCopyContent(lastRequest.request, 'Request', e)}
                      title="Click to copy request"
                    >
                      {JSON.stringify(lastRequest.request, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="font-semibold text-xs mb-1 text-gray-900">Response:</div>
                    <pre
                      className={`${lastRequest.response && typeof lastRequest.response === 'object' && 'error' in lastRequest.response ? 'bg-yellow-50 border-yellow-200 hover:bg-yellow-100' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'} border p-2 rounded text-xs overflow-auto max-h-32 text-gray-900 cursor-pointer transition-colors`}
                      onClick={(e) => handleCopyContent(lastRequest.response, 'Response', e)}
                      title="Click to copy response"
                    >
                      {JSON.stringify(lastRequest.response, null, 2)}
                    </pre>
                    {lastRequest.response && typeof lastRequest.response === 'object' && 'error' in lastRequest.response && (
                      <div className="text-xs text-yellow-600 mt-1 italic">
                        ⚠️ Response reading failed - HTTP request succeeded but response body could not be parsed
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-500">No successful requests yet</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>

        <span className="w-px h-2 bg-gray-200 flex-shrink-0"></span>

        {/* Fail Count */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex-1 flex justify-center items-center cursor-help hover:bg-red-50 transition-colors rounded">
              <span className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm">
                <X className="h-2.5 w-2.5 text-rose-500" />
                <span className="text-rose-600">{failCount}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-2xl max-h-[500px] overflow-y-auto z-[99999] bg-white/95 backdrop-blur-sm border border-gray-200 shadow-2xl text-gray-900">
            <div className="space-y-2">
              <div className="font-semibold text-sm text-gray-900">Last Failed Request</div>
              {lastRequest && lastRequest.error ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-600">
                    Timestamp: {new Date(lastRequest.timestamp).toLocaleString()}
                  </div>
                  {lastRequest.statusCode && (
                    <div className="text-xs text-gray-600">
                      Status Code: {lastRequest.statusCode}
                    </div>
                  )}
                  <div>
                    <div className="font-semibold text-xs mb-1 text-gray-900">Request:</div>
                    <pre
                      className="bg-gray-50 border border-gray-200 p-2 rounded text-xs overflow-auto max-h-24 text-gray-900 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={(e) => handleCopyContent(lastRequest.request, 'Request', e)}
                      title="Click to copy request"
                    >
                      {JSON.stringify(lastRequest.request, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <div className="font-semibold text-xs mb-1 text-red-600">Error:</div>
                    <pre
                      className="bg-red-50 border border-red-200 p-2 rounded text-xs overflow-auto max-h-32 text-red-700 cursor-pointer hover:bg-red-100 transition-colors"
                      onClick={(e) => handleCopyContent(lastRequest.error, 'Error', e)}
                      title="Click to copy error"
                    >
                      {lastRequest.error}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-500">No failed requests yet</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>
    </Badge>
  );
}

export function ProviderList({ providers, onEdit, onRemove, showToast, removeToast, requestStats, hoveredModel, onBadgeRef }: ProviderListProps) {
  // Wrap the entire provider list with a single TooltipProvider to avoid multiple providers
  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-center rounded-md border bg-white p-8 text-gray-500">
          No providers configured
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {providers.map((provider, index) => {
          if (!provider) {
            return (
              <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4">
                <div className="flex-1 space-y-1.5">
                  <p className="text-md font-semibold text-gray-800">Invalid Provider</p>
                </div>
                <Button variant="destructive" size="icon" onClick={() => onRemove(index)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          }

          const providerName = provider.name || "Unnamed Provider";
          const apiBaseUrl = provider.api_base_url || "No API URL";
          const models = Array.isArray(provider.models) ? provider.models : [];

          return (
            <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.005]">
              <div className="flex-1 space-y-2">
                <div className="space-y-0.5">
                  <p className="text-md font-semibold text-gray-800">{providerName}</p>
                  <p className="text-xs text-gray-400 font-mono">{apiBaseUrl}</p>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  {models.map((model, modelIndex) => (
                    <ModelBadge
                      key={`${index}-${modelIndex}`}
                      providerName={providerName}
                      model={model}
                      showToast={showToast}
                      removeToast={removeToast}
                      requestStats={requestStats}
                      isHovered={hoveredModel?.provider === providerName && hoveredModel?.model === model}
                      onBadgeRef={(ref) => onBadgeRef?.(providerName, model, ref)}
                    />
                  ))}
                </div>
              </div>

              <div className="ml-4 flex flex-shrink-0 items-center gap-2 self-start">
                <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="transition-all-ease hover:scale-110 h-8 w-8">
                  <Pencil className="h-4 w-4 text-gray-500" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => onRemove(index)} className="transition-all duration-200 hover:scale-110 hover:bg-red-50 h-8 w-8 group">
                  <Trash2 className="h-4 w-4 text-gray-400 group-hover:text-red-500 transition-colors duration-200" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
