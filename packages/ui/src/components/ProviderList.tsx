import { Pencil, Play, Trash2, Zap, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { getRequestStatus, getRequestStatsItem } from "@/lib/requestStatus";
import type { Provider } from "@/types";
import { getProviderModelUnion } from "@/lib/providerModels";
import type { RequestStatsItem } from "@/hooks/useRequestStats";
import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";

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
  searchTerm?: string;
  onBatchTestProvider?: (provider: Provider) => void;
}

// Extract base domain from URL (protocol + hostname + port only)
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
  } catch {
    return url;
  }
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
  apiKeys?: Array<{index: number, display: string}>;
}

function ModelBadge({ providerName, model, showToast, removeToast, requestStats, testPrompt, isHovered, onBadgeRef, apiKeys }: ModelBadgeProps) {
  const { t } = useTranslation();
  const [isTesting, setIsTesting] = useState(false);
  const [statsDetail, setStatsDetail] = useState<RequestStatsItem | null>(null);
  const [isLoadingStatsDetail, setIsLoadingStatsDetail] = useState(false);
  const badgeRef = useRef<HTMLDivElement>(null);

  // Register badge ref when component mounts
  useEffect(() => {
    if (onBadgeRef) {
      onBadgeRef(badgeRef.current);
    }
  }, [onBadgeRef, providerName, model]);

  // Find stats for current provider:model
  const stats = getRequestStatsItem(requestStats, providerName, model);
  const effectiveStats = statsDetail || stats;
  const successCount = stats?.success || 0;
  const failCount = stats?.fail || 0;
  const lastSuccessRequest = effectiveStats?.lastSuccessRequest;
  const lastFailureRequest = effectiveStats?.lastFailureRequest;

  useEffect(() => {
    setStatsDetail(null);
    setIsLoadingStatsDetail(false);
  }, [stats?.key]);

  const loadStatsDetail = useCallback(async () => {
    if (!stats?.key || statsDetail || isLoadingStatsDetail) return;
    setIsLoadingStatsDetail(true);
    try {
      const data = await api.getRequestStatsDetail(stats.key);
      if (data?.stat) {
        setStatsDetail(data.stat);
      }
    } catch (err) {
      console.error("Failed to load request stats detail:", err);
    } finally {
      setIsLoadingStatsDetail(false);
    }
  }, [isLoadingStatsDetail, stats?.key, statsDetail]);

  // Determine badge background color based on most recent event
  const getBadgeBackgroundClass = () => {
    const status = getRequestStatus(requestStats, providerName, model);
    switch (status) {
      case "success":
        return "bg-green-200";
      case "error":
        return "bg-red-200";
      default:
        return "bg-white";
    }
  };

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

  const handleTest = async (e: React.MouseEvent, keyIndex?: number) => {
    e.stopPropagation();
    if (isTesting) return;

    setIsTesting(true);
    const keyLabel = keyIndex !== undefined ? ` (Key #${keyIndex + 1})` : '';
    const textToTest = `${providerName},${model}${keyLabel}`;
    const toastId = showToast(`Testing ${textToTest}...`, 'warning', 0);

    try {
      const result = await api.testModel(providerName, model || "", testPrompt, keyIndex);
      removeToast(toastId);

      if (result?.success && result?.response) {
        showToast(`"${textToTest}" test OK\nResponse: ${result.response}`, 'success', 8000);
      } else if (result?.success) {
        showToast(`"${textToTest}" test OK`, 'success');
      } else {
        // Display error message from backend response with full details
        // Keep as is for toast to avoid overflow, don't format
        let errorMsg = result?.error || 'Unknown error';

        // If error is an object, stringify without formatting for toast
        if (typeof errorMsg === 'object') {
          try {
            errorMsg = JSON.stringify(errorMsg);
          } catch {
            errorMsg = String(errorMsg);
          }
        }

        // Add rawResponse and debug info if available (non-formatted)
        if (result?.rawResponse) {
          errorMsg += ` | Raw Response: ${JSON.stringify(result.rawResponse)}`;
        }
        if (result?.debug) {
          errorMsg += ` | Debug: ${JSON.stringify(result.debug)}`;
        }

        showToast(`"${textToTest}" test failed: ${errorMsg}`, 'error', 10000);
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
      className={`flex flex-row items-center h-auto py-1 px-2 gap-2 transition-all duration-200 hover:scale-105 cursor-pointer shadow-sm hover:shadow border-gray-200 w-fit max-w-full ${getBadgeBackgroundClass()} hover:bg-opacity-90 ${isHovered ? 'ring-2 ring-blue-500 ring-offset-2 border-blue-300' : ''}`}
      onClick={handleCopy}
    >
      {/* Model Name */}
      <span className="font-medium text-gray-700 text-xs break-all flex-1 min-w-0" title={model}>
        {model || "Unnamed Model"}
      </span>

      {/* Stats */}
      <div className="flex items-center gap-1 text-[10px] leading-none font-semibold text-gray-500">
        {/* Success Count */}
        <Tooltip onOpenChange={(open) => { if (open) void loadStatsDetail(); }}>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm cursor-help hover:bg-green-50 transition-colors">
              <Check className="h-3 w-3 text-emerald-500" />
              <span className="text-emerald-600">{successCount}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-2xl max-h-[500px] overflow-y-auto z-[99999] bg-white/95 backdrop-blur-sm border border-gray-200 shadow-2xl text-gray-900">
            <div className="space-y-2">
              <div className="font-semibold text-sm text-gray-900">Last Successful Request</div>
              {lastSuccessRequest ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-600">
                    Timestamp: {new Date(lastSuccessRequest.timestamp).toLocaleString()}
                  </div>
                  {lastSuccessRequest.request !== undefined || lastSuccessRequest.response !== undefined ? (
                    <>
                      <div>
                        <div className="font-semibold text-xs mb-1 text-gray-900">Request:</div>
                        <pre
                          className="bg-gray-50 border border-gray-200 p-2 rounded text-xs overflow-auto max-h-32 text-gray-900 cursor-pointer hover:bg-gray-100 transition-colors"
                          onClick={(e) => handleCopyContent(lastSuccessRequest.request, 'Request', e)}
                          title="Click to copy request"
                        >
                          {JSON.stringify(lastSuccessRequest.request, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="font-semibold text-xs mb-1 text-gray-900">Response:</div>
                        <pre
                          className={`${lastSuccessRequest.response && typeof lastSuccessRequest.response === 'object' && 'error' in lastSuccessRequest.response ? 'bg-yellow-50 border-yellow-200 hover:bg-yellow-100' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'} border p-2 rounded text-xs overflow-auto max-h-32 text-gray-900 cursor-pointer transition-colors`}
                          onClick={(e) => handleCopyContent(lastSuccessRequest.response, 'Response', e)}
                          title="Click to copy response"
                        >
                          {JSON.stringify(lastSuccessRequest.response, null, 2)}
                        </pre>
                        {lastSuccessRequest.response && typeof lastSuccessRequest.response === 'object' && 'error' in lastSuccessRequest.response && (
                          <div className="text-xs text-yellow-600 mt-1 italic">
                            Response reading failed - HTTP request succeeded but response body could not be parsed
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-500">
                      {isLoadingStatsDetail ? t("provider_list.loading_details") : t("provider_list.open_again_to_load_details")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-gray-500">No successful requests yet</div>
              )}
              {/* Per-key breakdown */}
              {apiKeys && apiKeys.length > 1 && (() => {
                const perKeyStats = requestStats?.filter(
                  s => s.provider === providerName && s.model === model && s.keyIndex !== undefined
                ) || [];
                if (perKeyStats.length === 0) return null;
                return (
                  <div className="border-t mt-2 pt-2">
                    <div className="font-semibold text-xs mb-1">Per-Key Breakdown</div>
                    <div className="space-y-0.5">
                      {perKeyStats.map(s => (
                        <div key={s.keyIndex} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">
                            Key #{(s.keyIndex ?? 0) + 1}
                            {apiKeys.find(k => k.index === s.keyIndex)?.display
                              ? ` (${apiKeys.find(k => k.index === s.keyIndex)?.display})`
                              : ''}
                          </span>
                          <span className="text-emerald-600">✓{s.success}</span>
                          <span className="text-rose-600">✗{s.fail}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Fail Count */}
        <Tooltip onOpenChange={(open) => { if (open) void loadStatsDetail(); }}>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm cursor-help hover:bg-red-50 transition-colors">
              <X className="h-3 w-3 text-rose-500" />
              <span className="text-rose-600">{failCount}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-2xl max-h-[500px] overflow-y-auto z-[99999] bg-white/95 backdrop-blur-sm border border-gray-200 shadow-2xl text-gray-900">
            <div className="space-y-2">
              <div className="font-semibold text-sm text-gray-900">Last Failed Request</div>
              {lastFailureRequest ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-600">
                    Timestamp: {new Date(lastFailureRequest.timestamp).toLocaleString()}
                  </div>
                  {lastFailureRequest.statusCode && (
                    <div className="text-xs text-gray-600">
                      Status Code: {lastFailureRequest.statusCode}
                    </div>
                  )}
                  {lastFailureRequest.request !== undefined || lastFailureRequest.error !== undefined ? (
                    <>
                      <div>
                        <div className="font-semibold text-xs mb-1 text-gray-900">Request:</div>
                        <pre
                          className="bg-gray-50 border border-gray-200 p-2 rounded text-xs overflow-auto max-h-24 text-gray-900 cursor-pointer hover:bg-gray-100 transition-colors"
                          onClick={(e) => handleCopyContent(lastFailureRequest.request, 'Request', e)}
                          title="Click to copy request"
                        >
                          {JSON.stringify(lastFailureRequest.request, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <div className="font-semibold text-xs mb-1 text-red-600">Error:</div>
                        <pre
                          className="bg-red-50 border border-red-200 p-2 rounded text-xs overflow-auto max-h-32 text-red-700 cursor-pointer hover:bg-red-100 transition-colors"
                          onClick={(e) => handleCopyContent(lastFailureRequest.error, 'Error', e)}
                          title="Click to copy error"
                        >
                          {(() => {
                            const error = lastFailureRequest.error;
                            if (typeof error === 'object') {
                              try { return JSON.stringify(error, null, 2); } catch { return String(error); }
                            }
                            if (typeof error === 'string') {
                              try { return JSON.stringify(JSON.parse(error), null, 2); } catch { return error; }
                            }
                            return String(error);
                          })()}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-500">
                      {isLoadingStatsDetail ? t("provider_list.loading_details") : t("provider_list.open_again_to_load_details")}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-gray-500">No failed requests yet</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Test Button - Right Side */}
      {apiKeys && apiKeys.length > 1 ? (
        <Popover>
          <PopoverTrigger asChild>
            <span
              className={`p-1 rounded-full hover:bg-gray-100 transition-colors flex-shrink-0 ${isTesting ? 'animate-pulse' : ''}`}
              title="Test availability"
              onClick={(e) => e.stopPropagation()}
            >
              <Zap className={`h-4 w-4 ${isTesting ? 'text-gray-400' : 'text-amber-500 fill-amber-500'}`} />
            </span>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-1" align="end" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col text-xs">
              <button
                onClick={(e) => { handleTest(e); }}
                className="px-3 py-1.5 text-left rounded hover:bg-gray-100 transition-colors whitespace-nowrap"
              >
                Auto
              </button>
              {apiKeys.map(k => (
                <button
                  key={k.index}
                  onClick={(e) => { handleTest(e, k.index); }}
                  className="px-3 py-1.5 text-left rounded hover:bg-gray-100 transition-colors whitespace-nowrap"
                >
                  Key #{k.index + 1} ({k.display})
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <span
          className={`p-1 rounded-full hover:bg-gray-100 transition-colors flex-shrink-0 ${isTesting ? 'animate-pulse' : ''}`}
          title="Test availability"
          onClick={handleTest}
        >
          <Zap className={`h-4 w-4 ${isTesting ? 'text-gray-400' : 'text-amber-500 fill-amber-500'}`} />
        </span>
      )}
    </Badge>
  );
}

interface ConnectivityTestButtonProps {
  apiBaseUrl: string;
  showToast: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  removeToast: (id: string) => void;
}

function ConnectivityTestButton({ apiBaseUrl, showToast, removeToast }: ConnectivityTestButtonProps) {
  const { t } = useTranslation();
  const [isTesting, setIsTesting] = useState(false);

  const handleTest = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTesting) return;

    setIsTesting(true);
    const toastId = showToast(t("provider_list.connectivity_testing", { url: apiBaseUrl }), 'warning', 0);

    try {
      const result = await api.testConnectivity(apiBaseUrl);
      removeToast(toastId);

      if (result?.success) {
        showToast(
          t("provider_list.connectivity_ok", { url: apiBaseUrl, ms: result.latency_ms, status: result.status }),
          'success',
          5000
        );
      } else {
        showToast(
          t("provider_list.connectivity_fail", { url: apiBaseUrl, error: result?.error || 'Unknown error' }),
          'error',
          8000
        );
      }
    } catch (err: any) {
      removeToast(toastId);
      showToast(
        t("provider_list.connectivity_fail", { url: apiBaseUrl, error: err?.message || 'Network error' }),
        'error',
        5000
      );
    } finally {
      setIsTesting(false);
    }
  }, [apiBaseUrl, isTesting, showToast, removeToast, t]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-center p-0.5 rounded hover:bg-gray-100 transition-colors cursor-pointer ${isTesting ? 'animate-pulse' : ''}`}
          onClick={handleTest}
        >
          <Zap className={`h-3 w-3 ${isTesting ? 'text-gray-400' : 'text-amber-500 fill-amber-500'}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs">
        {t("provider_list.connectivity_test")}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProviderList({ providers, onEdit, onRemove, showToast, removeToast, requestStats, hoveredModel, onBadgeRef, searchTerm = "", onBatchTestProvider }: ProviderListProps) {
  const { t } = useTranslation();
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
          const models = getProviderModelUnion(provider);

          // Determine if we should show all models based on match type
          const searchTermLower = searchTerm ? searchTerm.toLowerCase() : "";
          const isProviderMatch = searchTerm && (
            providerName.toLowerCase().includes(searchTermLower) ||
            apiBaseUrl.toLowerCase().includes(searchTermLower)
          );

          // If provider matches, show all models. Otherwise filter models by name.
          const filteredModels = isProviderMatch
            ? models
            : searchTermLower
              ? models.filter(model => model.toLowerCase().includes(searchTermLower))
              : models;

          // If searching but no models match and not a provider match, don't show this provider
          // (This logic might be redundant if the parent component already filters,
          // but good for safety if used independently)
          if (searchTerm && !isProviderMatch && filteredModels.length === 0) {
            return null;
          }

          return (
            <div key={index} className="flex flex-col sm:flex-row sm:items-start sm:justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.005] gap-3">
              <div className="flex-1 space-y-2 min-w-0">
                <div className="space-y-0.5">
                  <a
                    href={extractDomain(apiBaseUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-md font-semibold text-gray-800 hover:text-blue-600 hover:underline cursor-pointer transition-colors break-words"
                  >
                    {providerName}
                  </a>
                  <p className="text-xs text-gray-400 font-mono flex items-center gap-1 flex-wrap">
                    <span className="break-all">{apiBaseUrl}</span>
                    <ConnectivityTestButton
                      apiBaseUrl={apiBaseUrl}
                      showToast={showToast}
                      removeToast={removeToast}
                    />
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 pt-1">
                  {filteredModels.map((model, modelIndex) => (
                    <ModelBadge
                      key={`${index}-${modelIndex}`}
                      providerName={providerName}
                      model={model}
                      showToast={showToast}
                      removeToast={removeToast}
                      requestStats={requestStats}
                      isHovered={hoveredModel?.provider === providerName && hoveredModel?.model === model}
                      onBadgeRef={(ref) => onBadgeRef?.(providerName, model, ref)}
                      apiKeys={(() => {
                        const rawKeys = Array.isArray(provider.api_key) ? provider.api_key : [provider.api_key];
                        if (rawKeys.length <= 1) return undefined;
                        return rawKeys.map((entry: any, idx: number) => ({
                          index: idx,
                          display: (() => {
                            const k = typeof entry === 'string' ? entry : (entry?.key || '');
                            if (k.length <= 10) return '****';
                            return `${k.substring(0, 4)}...${k.substring(k.length - 4)}`;
                          })()
                        }));
                      })()}
                    />
                  ))}
                </div>
              </div>

              <div className="flex sm:flex-col gap-2 self-end sm:self-start flex-shrink-0">
                {onBatchTestProvider && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onBatchTestProvider(provider)}
                    className="transition-all-ease hover:scale-110 h-8 w-8"
                    title={t("provider_list.batch_test_provider")}
                  >
                    <Play className="h-4 w-4 text-blue-500" />
                  </Button>
                )}
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
