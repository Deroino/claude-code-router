import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, X, Copy, Download, Filter, Search, XCircle, Play, Square, Zap, Wifi, ChevronDown, ChevronRight, Trash2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useTranslation } from "react-i18next";
import { useConfig } from "@/components/ConfigProvider";
import type { Config } from "@/types";

export interface BatchTestResult {
  provider: string;
  model: string;
  keyIndex?: number;
  status: "success" | "error" | "pending" | "testing" | "idle" | "cancelled";
  message?: string;
  response?: string;
  timestamp?: number;
}

// Error type classification
export type ErrorType = "network" | "auth" | "model_unavailable" | "rate_limit" | "quota_exceeded" | "invalid_request" | "server_error" | "unknown";

/**
 * Extract all string values from an object recursively
 */
function extractStrings(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (typeof obj !== "object" || obj === null) return [];
  if (Array.isArray(obj)) return obj.flatMap(extractStrings);
  return Object.values(obj).flatMap(extractStrings);
}

/**
 * Classify error type based on error message/response content
 */
function getBatchTestResultKey(result: { provider: string; model: string; keyIndex?: number }): string {
  return result.keyIndex !== undefined
    ? `${result.provider}-${result.model}-key${result.keyIndex}`
    : `${result.provider}-${result.model}`;
}

function classifyError(result: BatchTestResult): ErrorType {
  if (result.status !== "error") return "unknown";

  const errorText = extractStrings([result.message, result.response])
    .join(" ")
    .toLowerCase();

  // Network errors - connection/timeout issues
  if (
    errorText.includes("network") ||
    errorText.includes("socket") ||
    errorText.includes("tls") ||
    errorText.includes("fetch failed") ||
    errorText.includes("econnrefused") ||
    errorText.includes("enotfound") ||
    errorText.includes("disconnect") ||
    errorText.includes("timeout") ||
    errorText.includes("timed out")
  ) {
    return "network";
  }

  // Auth errors - authentication/authorization issues
  if (
    errorText.includes("401") ||
    errorText.includes("unauthorized") ||
    errorText.includes("invalid key") ||
    errorText.includes("invalid token") ||
    errorText.includes("invalid api key") ||
    errorText.includes("无效的令牌") ||
    errorText.includes("无效令牌") ||
    errorText.includes("no auth available") ||
    errorText.includes("authentication")
  ) {
    return "auth";
  }

  // Quota exceeded - user/account quota issues
  if (
    errorText.includes("quota") ||
    errorText.includes("额度不足") ||
    errorText.includes("剩余额度") ||
    errorText.includes("insufficient") ||
    errorText.includes("余额") ||
    errorText.includes("欠费")
  ) {
    return "quota_exceeded";
  }

  // Rate limit - throttling/load issues
  if (
    errorText.includes("rate limit") ||
    errorText.includes("429") ||
    errorText.includes("too many") ||
    errorText.includes("throttl") ||
    errorText.includes("负载过高") ||
    errorText.includes("达到上限") ||
    errorText.includes("负载已")
  ) {
    return "rate_limit";
  }

  // Model unavailable - model not found or no channel
  if (
    errorText.includes("model_not_found") ||
    errorText.includes("no available channel") ||
    errorText.includes("无可用渠道") ||
    errorText.includes("无可用") ||
    errorText.includes("not found") ||
    errorText.includes("does not exist")
  ) {
    return "model_unavailable";
  }

  // Invalid request - malformed request
  if (
    errorText.includes("invalid") && (errorText.includes("request") || errorText.includes("format")) ||
    errorText.includes("bad request") ||
    errorText.includes("invalid_request")
  ) {
    return "invalid_request";
  }

  // Server errors - 5xx
  if (
    errorText.includes("500") ||
    errorText.includes("502") ||
    errorText.includes("503") ||
    errorText.includes("504") ||
    errorText.includes("internal_server_error") ||
    errorText.includes("server error")
  ) {
    return "server_error";
  }

  return "unknown";
}

interface BatchTestDialogProps {
  open: boolean;
  onClose: () => void;
  results: BatchTestResult[];
  title?: string;
  onRunTests?: (selectedTests: BatchTestResult[]) => void;
  onCancel?: () => void;
  isRunning?: boolean;
  concurrency?: number;
  onConcurrencyChange?: (value: number) => void;
  startedAt?: number | null;
  completedAt?: number | null;
  // Map from provider name to API URL for connectivity testing
  providerApiUrls?: Record<string, string>;
  // Callback to test connectivity for a specific URL
  onTestConnectivity?: (provider: string, url: string) => Promise<void>;
  // Toast notifications
  showToast?: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  // Callback when model is removed
  onModelRemoved?: (provider: string, model: string) => void;
  // Callback when removing failed models for a provider
  onFailedModelsRemoved?: (provider: string, models: string[]) => void;
  // Callback when retrying a single failed test
  onRetryTest?: (test: BatchTestResult) => void;
  // Callback when clearing all persisted results
  onClearResults?: () => Promise<void> | void;
}

export function BatchTestDialog({
  open,
  onClose,
  results,
  title,
  onRunTests,
  onCancel,
  isRunning = false,
  concurrency = 20,
  onConcurrencyChange,
  startedAt,
  completedAt,
  providerApiUrls = {},
  onTestConnectivity,
  showToast,
  onModelRemoved,
  onFailedModelsRemoved,
  onRetryTest,
  onClearResults,
}: BatchTestDialogProps) {
  const { t } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "error" | "testing" | "idle">("all");
  const [errorTypeFilter, setErrorTypeFilter] = useState<ErrorType | "all">("all");
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  const [collapsedProviders, setCollapsedProviders] = useState<Set<string>>(new Set());
  const [retryingErrorKeys, setRetryingErrorKeys] = useState<Set<string>>(new Set());
  const { config, setConfig } = useConfig();

  // Extract base domain from URL (protocol + hostname + port only)
  const extractDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}${urlObj.port ? ':' + urlObj.port : ''}`;
    } catch {
      return url;
    }
  };

  const removeModelFromConfig = (currentConfig: Config, providerName: string, modelName: string): Config => {
    const newConfig = { ...currentConfig };

    // 1. Remove from every key assignment under the provider
    if (newConfig.Providers) {
      newConfig.Providers = newConfig.Providers.map((p) => {
        if (p.name !== providerName) {
          return p;
        }

        const rawKeys = Array.isArray(p.api_key) ? p.api_key : [p.api_key];
        const nextKeys = rawKeys.map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }

          const nextModels = entry.models?.filter((m: string) => m !== modelName);
          return {
            ...entry,
            ...(nextModels && nextModels.length > 0 ? { models: nextModels } : {}),
          };
        });

        const nextApiKey = (Array.isArray(p.api_key) ? nextKeys : nextKeys[0]) as typeof p.api_key;

        return {
          ...p,
          api_key: nextApiKey,
        };
      });
    }

    const fullModelName = `${providerName},${modelName}`;

    // 2. Clean up Router references
    if (newConfig.Router) {
      const newRouter = { ...newConfig.Router };
      (['default', 'background', 'think', 'longContext', 'webSearch', 'image', 'compact'] as const).forEach(key => {
        if (newRouter[key] === fullModelName) {
          (newRouter as any)[key] = '';
        }
      });
      newConfig.Router = newRouter;
    }

    // 3. Clean up ModelGroups references
    if (newConfig.ModelGroups) {
      newConfig.ModelGroups = newConfig.ModelGroups.map(group => ({
        ...group,
        models: group.models.filter(m => m !== fullModelName)
      }));
    }

    return newConfig;
  };

  const handleRemoveModel = (providerName: string, modelName: string) => {
    if (!config) return;

    const newConfig = removeModelFromConfig(config, providerName, modelName);
    setConfig(newConfig);
    setSelectedTests(prev => {
      const next = new Set(prev);
      results.forEach((result, index) => {
        if (result.provider === providerName && result.model === modelName) {
          next.delete(`${result.provider}-${result.model}-${index}`);
        }
      });
      return next;
    });
    if (showToast) {
      showToast(t("batch_test.model_removed", { provider: providerName, model: modelName }), 'success');
    }
    if (onModelRemoved) {
      onModelRemoved(providerName, modelName);
    }
  };

  const clearSelectedTestsByModels = (providerName: string, modelNames: string[]) => {
    const modelSet = new Set(modelNames);
    setSelectedTests(prev => {
      const next = new Set(prev);
      results.forEach((result, index) => {
        if (result.provider === providerName && modelSet.has(result.model)) {
          next.delete(`${result.provider}-${result.model}-${index}`);
        }
      });
      return next;
    });
  };

  const handleRemoveFailedModels = (providerName: string, providerResults: Array<BatchTestResult & { id: string }>) => {
    if (!config) return;

    const failedModels = Array.from(new Set(
      providerResults
        .filter(result => result.status === "error")
        .map(result => result.model)
    ));

    if (failedModels.length === 0) return;

    let newConfig = config;
    failedModels.forEach(modelName => {
      newConfig = removeModelFromConfig(newConfig, providerName, modelName);
    });

    setConfig(newConfig);
    clearSelectedTestsByModels(providerName, failedModels);
    if (showToast) {
      showToast(t("batch_test.failed_models_removed", { provider: providerName, count: failedModels.length }), 'success');
    }
    onFailedModelsRemoved?.(providerName, failedModels);
  };


  // Initialize selected tests when results change
  useEffect(() => {
    if (open && results.length > 0) {
      // Default: select none, let users manually select
      setSelectedTests(new Set());
    }
  }, [open, results.length]);

  // Default collapse all providers when dialog opens
  useEffect(() => {
    if (open && results.length > 0) {
      const providers = new Set(results.map(r => r.provider || "Unknown"));
      setCollapsedProviders(providers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setRetryingErrorKeys(prev => {
      if (prev.size === 0) return prev;
      const resultMap = new Map(results.map(result => [getBatchTestResultKey(result), result]));
      const next = new Set<string>();
      prev.forEach(key => {
        const result = resultMap.get(key);
        if (result && (result.status === "idle" || result.status === "pending" || result.status === "testing")) {
          next.add(key);
        }
      });
      return next;
    });
  }, [results]);

  const filteredResults = results.map((r, index) => ({...r, id: `${r.provider}-${r.model}-${index}`, stableKey: getBatchTestResultKey(r), errorType: classifyError(r)})).filter(r => {
    // Apply status filter
    if (statusFilter === "all") {
      // pass
    } else if (statusFilter === "testing") {
      if (r.status !== "testing" && r.status !== "pending") return false;
    } else if (statusFilter === "error") {
      if (r.status !== "error" && !retryingErrorKeys.has(r.stableKey)) return false;
    } else {
      if (r.status !== statusFilter) return false;
    }

    // Apply error type filter (only applicable to error status)
    if (errorTypeFilter !== "all") {
      if (r.status !== "error") return false;
      const errType = classifyError(r);
      if (errType !== errorTypeFilter) return false;
    }

    // Apply search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const providerMatch = r.provider && r.provider.toLowerCase().includes(term);
      const modelMatch = r.model && r.model.toLowerCase().includes(term);
      const messageMatch = r.message && typeof r.message === 'string' && r.message.toLowerCase().includes(term);
      const responseMatch = r.response && typeof r.response === 'string' && r.response.toLowerCase().includes(term);
      if (!providerMatch && !modelMatch && !messageMatch && !responseMatch) return false;
    }

    return true;
  });

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const testingCount = results.filter(r => r.status === "testing" || r.status === "pending").length;
  const completedCount = results.filter(r => r.status === "success" || r.status === "error" || r.status === "cancelled").length;

  // Error type statistics
  const errorResults = results.filter(r => r.status === "error");
  const errorTypeStats = {
    network: errorResults.filter(r => classifyError(r) === "network").length,
    auth: errorResults.filter(r => classifyError(r) === "auth").length,
    quota_exceeded: errorResults.filter(r => classifyError(r) === "quota_exceeded").length,
    rate_limit: errorResults.filter(r => classifyError(r) === "rate_limit").length,
    model_unavailable: errorResults.filter(r => classifyError(r) === "model_unavailable").length,
    invalid_request: errorResults.filter(r => classifyError(r) === "invalid_request").length,
    server_error: errorResults.filter(r => classifyError(r) === "server_error").length,
    unknown: errorResults.filter(r => classifyError(r) === "unknown").length,
  };

  // Group filtered results by provider
  const groupedResults = filteredResults.reduce((acc, r) => {
    const provider = r.provider || "Unknown";
    if (!acc[provider]) {
      acc[provider] = [];
    }
    acc[provider].push(r);
    return acc;
  }, {} as Record<string, typeof filteredResults>);

  // Toggle provider collapse
  const toggleProviderCollapse = (provider: string) => {
    setCollapsedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  };

  // Toggle all providers
  const toggleAllProviders = (collapse: boolean) => {
    if (collapse) {
      setCollapsedProviders(new Set(Object.keys(groupedResults)));
    } else {
      setCollapsedProviders(new Set());
    }
  };

  const handleCopyResults = () => {
    const text = filteredResults.map(r => {
      const statusIcon = r.status === "success" ? "✓" : r.status === "error" ? "✗" : r.status === "testing" ? "⟳" : r.status === "cancelled" ? "⊘" : "?";
      const message = r.message ? ` - ${r.message}` : "";
      const response = r.response ? `\n  Response: ${r.response}` : "";
      return `${statusIcon} ${r.provider}/${r.model}${message}${response}`;
    }).join("\n");
    navigator.clipboard.writeText(text);
  };

  const handleDownloadResults = () => {
    const data = filteredResults.map(r => ({
      provider: r.provider,
      model: r.model,
      status: r.status,
      message: r.message || "",
      response: r.response || "",
      timestamp: r.timestamp ? new Date(r.timestamp).toISOString() : ""
    }));
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `batch-test-results-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleSelection = (id: string) => {
    setSelectedTests(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAllSelection = () => {
    if (selectedTests.size === filteredResults.length) {
      setSelectedTests(new Set());
    } else {
      const next = new Set<string>();
      filteredResults.forEach(r => next.add(r.id));
      setSelectedTests(next);
    }
  };

  const handleRunSelectedTests = () => {
    if (onRunTests) {
      const selected = results.filter((_, index) => {
        const r = results[index];
        const id = `${r.provider}-${r.model}-${index}`;
        return selectedTests.has(id);
      });
      const retriedErrorKeys = selected
        .filter(test => test.status === "error")
        .map(test => getBatchTestResultKey(test));
      if (retriedErrorKeys.length > 0) {
        setRetryingErrorKeys(prev => new Set([...prev, ...retriedErrorKeys]));
      }
      onRunTests(selected);
    }
  };

  const handleRetrySingleTest = (test: BatchTestResult) => {
    if (test.status === "error") {
      setRetryingErrorKeys(prev => new Set([...prev, getBatchTestResultKey(test)]));
    }
    onRetryTest?.(test);
  };

  const handleClearResults = async () => {
    if (!onClearResults) return;
    await onClearResults();
    setSelectedTests(new Set());
    setCollapsedProviders(new Set());
    setRetryingErrorKeys(new Set());
    setStatusFilter("all");
    setErrorTypeFilter("all");
    setSearchTerm("");
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{title || t("batch_test.title")}</span>
            {isRunning && (
              <span className="text-sm font-normal text-gray-500 animate-pulse">
                {t("batch_test.backend_running")} [{completedCount}/{results.length}]
              </span>
            )}
          </DialogTitle>
          {/* Test time info */}
          {(startedAt || completedAt) && (
            <div className="text-xs text-gray-500 flex gap-4 mt-1">
              {startedAt && (
                <span>
                  {t("batch_test.started_at")}: {new Date(startedAt).toLocaleString()}
                </span>
              )}
              {completedAt && (
                <span>
                  {t("batch_test.completed_at")}: {new Date(completedAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
        </DialogHeader>

        {/* Filter and Actions */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:justify-between">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="h-4 w-4 text-gray-500 hidden sm:block" />
            <div className="flex gap-2 flex-wrap">
              <Button
                variant={statusFilter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => { setStatusFilter("all"); setErrorTypeFilter("all"); }}
              >
                {t("batch_test.all")} ({results.length})
              </Button>
              <Button
                variant={statusFilter === "success" ? "default" : "outline"}
                size="sm"
                onClick={() => { setStatusFilter("success"); setErrorTypeFilter("all"); }}
              >
                <Check className="h-3 w-3 mr-1" />
                {t("batch_test.success")} ({successCount})
              </Button>
              <Button
                variant={statusFilter === "error" ? "default" : "outline"}
                size="sm"
                onClick={() => { setStatusFilter("error"); setErrorTypeFilter("all"); }}
              >
                <X className="h-3 w-3 mr-1" />
                {t("batch_test.failed")} ({errorCount})
              </Button>
            </div>
          </div>

          <div className="flex gap-2 items-center flex-wrap">
            <div className="relative flex-1 sm:flex-none">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              <Input
                placeholder={t("batch_test.search")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-8 w-full sm:w-48"
              />
              {searchTerm && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                  onClick={() => setSearchTerm("")}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyResults}
            >
              <Copy className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">{t("batch_test.copy")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadResults}
            >
              <Download className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">{t("batch_test.export")}</span>
            </Button>
          </div>
        </div>

        {/* Error Type Filter - Only show when status filter is "error" or "all" and there are errors */}
        {(statusFilter === "error" || statusFilter === "all") && errorCount > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">{t("batch_test.error_type")}:</span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className={`h-7 text-xs transition-all ${
                  errorTypeFilter === "all"
                    ? "bg-slate-200 text-slate-800 hover:bg-slate-300"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
                onClick={() => setErrorTypeFilter("all")}
              >
                {t("batch_test.all")} ({errorCount})
              </Button>
              {errorTypeStats.network > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "network"
                      ? "bg-orange-500 text-white hover:bg-orange-600"
                      : "text-orange-600 hover:bg-orange-50"
                  }`}
                  onClick={() => setErrorTypeFilter("network")}
                >
                  {t("batch_test.error_network")} ({errorTypeStats.network})
                </Button>
              )}
              {errorTypeStats.auth > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "auth"
                      ? "bg-red-500 text-white hover:bg-red-600"
                      : "text-red-600 hover:bg-red-50"
                  }`}
                  onClick={() => setErrorTypeFilter("auth")}
                >
                  {t("batch_test.error_auth")} ({errorTypeStats.auth})
                </Button>
              )}
              {errorTypeStats.quota_exceeded > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "quota_exceeded"
                      ? "bg-amber-500 text-white hover:bg-amber-600"
                      : "text-amber-600 hover:bg-amber-50"
                  }`}
                  onClick={() => setErrorTypeFilter("quota_exceeded")}
                >
                  {t("batch_test.error_quota_exceeded")} ({errorTypeStats.quota_exceeded})
                </Button>
              )}
              {errorTypeStats.rate_limit > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "rate_limit"
                      ? "bg-yellow-500 text-white hover:bg-yellow-600"
                      : "text-yellow-600 hover:bg-yellow-50"
                  }`}
                  onClick={() => setErrorTypeFilter("rate_limit")}
                >
                  {t("batch_test.error_rate_limit")} ({errorTypeStats.rate_limit})
                </Button>
              )}
              {errorTypeStats.model_unavailable > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "model_unavailable"
                      ? "bg-purple-500 text-white hover:bg-purple-600"
                      : "text-purple-600 hover:bg-purple-50"
                  }`}
                  onClick={() => setErrorTypeFilter("model_unavailable")}
                >
                  {t("batch_test.error_model_unavailable")} ({errorTypeStats.model_unavailable})
                </Button>
              )}
              {errorTypeStats.invalid_request > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "invalid_request"
                      ? "bg-pink-500 text-white hover:bg-pink-600"
                      : "text-pink-600 hover:bg-pink-50"
                  }`}
                  onClick={() => setErrorTypeFilter("invalid_request")}
                >
                  {t("batch_test.error_invalid_request")} ({errorTypeStats.invalid_request})
                </Button>
              )}
              {errorTypeStats.server_error > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "server_error"
                      ? "bg-slate-600 text-white hover:bg-slate-700"
                      : "text-slate-600 hover:bg-slate-50"
                  }`}
                  onClick={() => setErrorTypeFilter("server_error")}
                >
                  {t("batch_test.error_server")} ({errorTypeStats.server_error})
                </Button>
              )}
              {errorTypeStats.unknown > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 text-xs transition-all ${
                    errorTypeFilter === "unknown"
                      ? "bg-gray-500 text-white hover:bg-gray-600"
                      : "text-gray-500 hover:bg-gray-50"
                  }`}
                  onClick={() => setErrorTypeFilter("unknown")}
                >
                  {t("batch_test.error_unknown")} ({errorTypeStats.unknown})
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Results Table */}
        <div className="flex-grow overflow-y-auto border rounded-md">
          {/* Header with collapse all/expand all buttons */}
          <div className="bg-gray-50 border-b px-3 py-2 flex items-center justify-between sticky top-0 z-10">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={selectedTests.size > 0 && selectedTests.size === filteredResults.length}
                onCheckedChange={toggleAllSelection}
                aria-label={t("batch_test.select_all")}
              />
              <span className="text-xs text-gray-500">{t("batch_test.select_all")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => toggleAllProviders(true)}
              >
                {t("batch_test.collapse_all")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs"
                onClick={() => toggleAllProviders(false)}
              >
                {t("batch_test.expand_all")}
              </Button>
            </div>
          </div>

          {filteredResults.length === 0 ? (
            <div className="text-center p-8 text-gray-500">
              {t("batch_test.no_results")}
            </div>
          ) : (
            <div className="divide-y">
              {Object.entries(groupedResults).map(([provider, providerResults]) => {
                const isCollapsed = collapsedProviders.has(provider);
                const providerSuccessCount = providerResults.filter(r => r.status === "success").length;
                const providerErrorCount = providerResults.filter(r => r.status === "error").length;
                const providerSelectedCount = providerResults.filter(r => selectedTests.has(r.id)).length;
                const providerHasFailedModels = providerErrorCount > 0;

                return (
                  <div key={provider} className="bg-white">
                    {/* Provider Header Row */}
                    <div
                      className="flex items-center gap-2 px-3 py-2 bg-gray-50/80 hover:bg-gray-100 cursor-pointer border-b"
                      onClick={() => toggleProviderCollapse(provider)}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4 text-gray-500" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-gray-500" />
                      )}
                      <span
                        className="font-medium text-sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={providerSelectedCount === providerResults.length}
                          onCheckedChange={() => {
                            const allSelected = providerSelectedCount === providerResults.length;
                            setSelectedTests(prev => {
                              const next = new Set(prev);
                              providerResults.forEach(r => {
                                if (allSelected) {
                                  next.delete(r.id);
                                } else {
                                  next.add(r.id);
                                }
                              });
                              return next;
                            });
                          }}
                        />
                      </span>
                      <span className="font-medium text-sm">{provider}</span>
                      <span className="text-xs text-gray-500">
                        ({providerResults.length} {t("batch_test.models")})
                      </span>
                      {providerSuccessCount > 0 && (
                        <Badge className="bg-emerald-100 text-emerald-700 text-[10px] px-1.5">
                          {providerSuccessCount} {t("batch_test.success")}
                        </Badge>
                      )}
                      {providerErrorCount > 0 && (
                        <Badge className="bg-rose-100 text-rose-700 text-[10px] px-1.5">
                          {providerErrorCount} {t("batch_test.failed")}
                        </Badge>
                      )}
                      <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 p-0 text-gray-400 hover:text-red-500 hover:bg-red-50"
                          onClick={() => handleRemoveFailedModels(provider, providerResults)}
                          disabled={!providerHasFailedModels}
                          title={t("batch_test.remove_failed_models")}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Models Table (when expanded) */}
                    {!isCollapsed && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm min-w-[500px]">
                        <thead className="bg-gray-50/50">
                          <tr>
                            <th className="w-10 p-2 border-b text-center whitespace-nowrap"></th>
                            <th className="text-left p-2 font-medium border-b whitespace-nowrap text-xs">{t("batch_test.model")}</th>
                            <th className="text-left p-2 font-medium border-b whitespace-nowrap text-xs">{t("batch_test.status")}</th>
                            <th className="text-left p-2 font-medium border-b text-xs">{t("batch_test.details")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {providerResults.map((result) => (
                            <tr
                              key={result.id}
                              className={`border-b hover:bg-gray-50 ${selectedTests.has(result.id) ? 'bg-blue-50/50' : ''}`}
                              onClick={() => toggleSelection(result.id)}
                            >
                              <td className="p-2 text-center whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={selectedTests.has(result.id)}
                                  onCheckedChange={() => toggleSelection(result.id)}
                                />
                              </td>
                              <td className="p-2 font-mono text-xs whitespace-nowrap">
                                {result.model}
                                {result.keyIndex !== undefined && (
                                  <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0 font-normal text-muted-foreground">
                                    Key #{result.keyIndex + 1}
                                  </Badge>
                                )}
                              </td>
                              <td className="p-2 whitespace-nowrap">
                                {result.status === "success" && (
                                  <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
                                    <Check className="h-3 w-3 mr-1" />
                                    {t("batch_test.success_status")}
                                  </Badge>
                                )}
                                {result.status === "error" && (() => {
                                  const errType = classifyError(result);
                                  return (
                                    <div className="flex flex-col gap-1">
                                      <div className="flex items-center gap-1">
                                        <Badge className="bg-rose-100 text-rose-700 border-rose-200">
                                          <X className="h-3 w-3 mr-1" />
                                          {t("batch_test.failed_status")}
                                        </Badge>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 p-0 text-gray-400 hover:text-blue-500 hover:bg-blue-50"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRetrySingleTest(result);
                                          }}
                                          title={t("batch_test.retry")}
                                        >
                                          <RotateCcw className="h-3 w-3" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon"
                                          className="h-6 w-6 p-0 text-gray-400 hover:text-red-500 hover:bg-red-50"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRemoveModel(result.provider, result.model);
                                          }}
                                          title={t("batch_test.remove_model.button")}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </div>
                                      {errType !== "unknown" && (
                                        <Badge
                                          className={`text-[10px] px-1.5 py-0 flex items-center gap-0.5 ${
                                            errType === "network" ? "bg-orange-50 text-orange-600 border-orange-200" :
                                            errType === "auth" ? "bg-red-50 text-red-600 border-red-200" :
                                            errType === "rate_limit" ? "bg-yellow-50 text-yellow-600 border-yellow-200" :
                                            errType === "model_unavailable" ? "bg-purple-50 text-purple-600 border-purple-200" :
                                            errType === "quota_exceeded" ? "bg-amber-50 text-amber-600 border-amber-200" :
                                            errType === "invalid_request" ? "bg-pink-50 text-pink-600 border-pink-200" :
                                            errType === "server_error" ? "bg-slate-100 text-slate-600 border-slate-200" :
                                            "bg-gray-50 text-gray-500 border-gray-200"
                                          }`}
                                        >
                                          <span>{t(`batch_test.error_${errType}`)}</span>
                                          {errType === "network" && onTestConnectivity && providerApiUrls[result.provider] && (
                                            <span
                                              className="ml-0.5 cursor-pointer hover:text-amber-500 transition-colors"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                onTestConnectivity(result.provider, providerApiUrls[result.provider]);
                                              }}
                                              title={t("batch_test.test_connectivity")}
                                            >
                                              <Zap className="h-3 w-3" />
                                            </span>
                                          )}
                                        </Badge>
                                      )}
                                    </div>
                                  );
                                })()}
                                {result.status === "testing" && (
                                  <Badge className="bg-amber-100 text-amber-700 border-amber-200 animate-pulse">
                                    {t("batch_test.testing_status")}
                                  </Badge>
                                )}
                                {result.status === "pending" && (
                                  <Badge variant="outline">
                                    {t("batch_test.pending")}
                                  </Badge>
                                )}
                                {result.status === "idle" && (
                                  <Badge variant="outline" className="text-gray-500 border-gray-200">
                                    {t("batch_test.idle")}
                                  </Badge>
                                )}
                                {result.status === "cancelled" && (
                                  <Badge variant="outline" className="text-orange-500 border-orange-200">
                                    {t("batch_test.cancelled_status")}
                                  </Badge>
                                )}
                              </td>
                              <td className="p-2 min-w-[200px]">
                                <div className="space-y-1">
                                  {result.message && (
                                    <div className="text-xs text-gray-600 truncate" title={typeof result.message === 'string' ? result.message : JSON.stringify(result.message)}>
                                      {typeof result.message === 'string' ? result.message : JSON.stringify(result.message)}
                                    </div>
                                  )}
                                  {result.response && (
                                    <div className="text-xs text-gray-500 max-w-xs truncate" title={typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}>
                                      {typeof result.response === 'string' ? result.response : JSON.stringify(result.response)}
                                    </div>
                                  )}
                                  {result.timestamp && (
                                    <div className="text-xs text-gray-400">
                                      <span className="text-gray-500">{t("batch_test.timestamp")}:</span> {new Date(result.timestamp).toLocaleString()}
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between items-center">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">
              {t("batch_test.selected", { count: selectedTests.size })}
            </span>
            {/* Concurrency input */}
            {onConcurrencyChange && (
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-gray-500">{t("batch_test.concurrency")}:</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={concurrency}
                  onChange={(e) => onConcurrencyChange(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-16 h-8 text-sm"
                  disabled={isRunning}
                />
              </div>
            )}
          </div>
          <div className="flex gap-2">
            {!isRunning && onClearResults && (
              <Button
                variant="outline"
                onClick={() => void handleClearResults()}
                className="gap-2 text-red-600 hover:text-red-700"
              >
                <Trash2 className="h-4 w-4" />
                {t("batch_test.clear_results")}
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              {t("batch_test.close")}
            </Button>
            {isRunning && onCancel && (
              <Button
                variant="destructive"
                onClick={onCancel}
                className="gap-2"
              >
                <Square className="h-4 w-4" />
                {t("batch_test.cancel")}
              </Button>
            )}
            {!isRunning && onTestConnectivity && (
              <Button
                variant="outline"
                onClick={() => {
                  // Get unique providers from selected tests
                  const selectedProviders = new Set<string>();
                  filteredResults.forEach((r) => {
                    if (selectedTests.has(r.id) && providerApiUrls[r.provider]) {
                      selectedProviders.add(r.provider);
                    }
                  });
                  // Test each provider's URL
                  selectedProviders.forEach((provider) => {
                    onTestConnectivity(provider, providerApiUrls[provider]);
                  });
                }}
                disabled={selectedTests.size === 0}
                className="gap-2"
              >
                <Wifi className="h-4 w-4" />
                {t("batch_test.test_connectivity")}
              </Button>
            )}
            {!isRunning && onRunTests && (
              <Button
                onClick={handleRunSelectedTests}
                disabled={selectedTests.size === 0}
                className="gap-2"
              >
                <Play className="h-4 w-4" />
                {t("batch_test.run_selected")}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
