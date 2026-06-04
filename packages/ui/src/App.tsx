import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Transformers } from "@/components/Transformers";
import { ModelGroups } from "@/components/ModelGroups";
import { Providers } from "@/components/Providers";
import { Router } from "@/components/Router";
import { JsonEditor } from "@/components/JsonEditor";
import { LogViewer } from "@/components/LogViewer";
import { ModelMonitorPanel } from "@/components/ModelMonitorPanel";
import { BatchTestDialog } from "@/components/BatchTestDialog";
import type { BatchTestResult } from "@/components/BatchTestDialog";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";
import {
  buildBatchTestsForModelValues,
  buildFreshBatchTests,
  filterProviderBatchTestResults,
  filterRemovedBatchTestResult,
  filterRemovedBatchTestResults,
  getSelectedRouterModelValues,
  markBatchTestsAsTesting,
  mergeBatchTestResults,
  mergePersistedBatchTests,
  type BatchTestTarget,
} from "@/lib/batchTests";
import { useModelMonitorLogs } from "@/hooks/useModelMonitorLogs";
import { useRequestStats } from "@/hooks/useRequestStats";
import {
  Settings,
  Languages,
  RefreshCw,
  FileJson,
  CircleArrowUp,
  FileText,
  FileCog,
  Activity,
  Server,
  Route,
  Workflow,
  Layers,
  LayoutDashboard,
  Menu,
  X
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import "@/styles/animations.css";

function App() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { config, error, isSaving } = useConfig();

  // Dialog states
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isJsonEditorOpen, setIsJsonEditorOpen] = useState(false);
  const [isLogViewerOpen, setIsLogViewerOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // Panel visibility states
  const [showProviders, setShowProviders] = useState(true);
  const [showRouter, setShowRouter] = useState(false);
  const [showTransformers, setShowTransformers] = useState(false);
  const [showModelGroups, setShowModelGroups] = useState(false);
  const [showModelMonitor, setShowModelMonitor] = useState(true);

  // Hover model state for cross-component highlighting
  const [hoveredModel, setHoveredModel] = useState<{ provider: string | null; model: string | null } | undefined>(undefined);

  // Badge refs for auto-scroll to highlighted element
  const badgeRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Model Monitor Data - Always keep SSE connection alive, regardless of panel visibility
  const { logs: modelMonitorLogs, currentFile: modelMonitorFile, status: modelMonitorStatus } = useModelMonitorLogs({
    isOpen: true,
    maxItems: 50
  });

  // Get request statistics for model status display
  const { stats: requestStats } = useRequestStats();

  // Shared batch test state used by Providers, Router, and Model Groups.
  const [showBatchTestDialog, setShowBatchTestDialog] = useState(false);
  const [batchTestResults, setBatchTestResults] = useState<BatchTestResult[]>([]);
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const [batchTestConcurrency, setBatchTestConcurrency] = useState(20);
  const [batchTestStartedAt, setBatchTestStartedAt] = useState<number | null>(null);
  const [batchTestCompletedAt, setBatchTestCompletedAt] = useState<number | null>(null);
  const [batchTestTitle, setBatchTestTitle] = useState<string>(t("batch_test.title"));
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const providerApiUrls = useMemo(() => {
    const providers = Array.isArray(config?.Providers) ? config.Providers : [];
    return Object.fromEntries(
      providers
        .filter(provider => provider.name && provider.api_base_url)
        .map(provider => [provider.name, provider.api_base_url])
    );
  }, [config?.Providers]);

  // Handle hover on model from ModelMonitorPanel
  const handleHoverModel = useCallback((provider: string | null, model: string | null) => {
    console.log('[App] handleHoverModel:', { provider, model });
    setHoveredModel({ provider, model });

    // Auto-scroll to the badge in Provider panel when hovering
    if (provider && model) {
      const key = `${provider},${model}`;
      const badgeElement = badgeRefs.current.get(key);
      console.log('[App] Looking for badge:', key, 'found:', !!badgeElement);
      if (badgeElement) {
        badgeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }
  }, []);

  // Register badge ref from ProviderList
  const handleBadgeRef = useCallback((provider: string, model: string, ref: HTMLDivElement | null) => {
    const key = `${provider},${model}`;
    if (ref) {
      badgeRefs.current.set(key, ref);
    } else {
      badgeRefs.current.delete(key);
    }
  }, []);

  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [toasts, setToasts] = useState<{ id: string; message: string; type: 'success' | 'error' | 'warning' | 'info'; duration?: number; exiting?: boolean }[]>([]);
  // 版本检查状态
  const [isNewVersionAvailable, setIsNewVersionAvailable] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [newVersionInfo, setNewVersionInfo] = useState<{ version: string; changelog: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [hasCheckedUpdate, setHasCheckedUpdate] = useState(false);
  const [isUpdateFeatureAvailable, setIsUpdateFeatureAvailable] = useState(true);
  const hasAutoCheckedUpdate = useRef(false);

  // Maximum number of *visible* (non-exiting) toasts on screen at once.
  // Anything older than this gets flagged as `exiting` so it plays the same
  // exit animation as a regular dismissal instead of vanishing instantly.
  const TOAST_VISIBLE_LIMIT = 5;

  // Show toast function with max limit
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info', duration?: number) => {
    const id = Date.now() + Math.random().toString(36).substring(2);
    setToasts(prev => {
      const next = [...prev, { id, message, type, duration }];
      // Count only toasts that are still in their "visible" lifecycle —
      // toasts already mid-exit-animation don't count toward the limit.
      const visibleCount = next.filter(t => !t.exiting).length;
      if (visibleCount > TOAST_VISIBLE_LIMIT) {
        let toEvict = visibleCount - TOAST_VISIBLE_LIMIT;
        // Evict the oldest non-exiting toasts first by flipping their
        // `exiting` flag. The Toast component will react, play the slide-out
        // animation, then call `removeToast` to drop it from the array.
        return next.map(t => {
          if (toEvict > 0 && !t.exiting) {
            toEvict--;
            return { ...t, exiting: true };
          }
          return t;
        });
      }
      return next;
    });
    return id;
  }, []);

  // Remove toast function
  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const pollBatchTestStatus = useCallback(async () => {
    try {
      const status = await api.getBatchTestStatus();
      if (status.results?.length > 0) {
        setBatchTestResults(prev => mergeBatchTestResults(prev, status.results));
      }
      if (status.startedAt !== undefined) {
        setBatchTestStartedAt(status.startedAt);
      }
      if (status.completedAt !== undefined) {
        setBatchTestCompletedAt(status.completedAt);
      }

      if (status.status === "running" || status.status === "cancelling") {
        setIsBatchTesting(true);
      } else {
        setIsBatchTesting(false);
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch (err) {
      console.error("Failed to poll batch test status:", err);
    }
  }, []);

  const startBatchTestPolling = useCallback(() => {
    if (pollTimerRef.current) return;
    pollTimerRef.current = setInterval(pollBatchTestStatus, 2000);
  }, [pollBatchTestStatus]);

  const handleOpenBatchTest = useCallback(async (tests: BatchTestTarget[], title?: string) => {
    if (tests.length === 0) {
      showToast(t("batch_test.no_models_to_test"), "warning");
      return;
    }

    setBatchTestTitle(title || t("batch_test.title"));
    try {
      const data = await api.getBatchTestResults();
      if (data?.results?.length > 0) {
        setBatchTestResults(mergePersistedBatchTests(tests, data.results));
        setBatchTestStartedAt(data.startedAt ?? null);
        setBatchTestCompletedAt(data.completedAt ?? null);
      } else {
        setBatchTestResults(buildFreshBatchTests(tests));
        setBatchTestStartedAt(null);
        setBatchTestCompletedAt(null);
      }
    } catch {
      setBatchTestResults(buildFreshBatchTests(tests));
      setBatchTestStartedAt(null);
      setBatchTestCompletedAt(null);
    }

    setShowBatchTestDialog(true);
  }, [showToast, t]);

  const handleRunBatchTests = useCallback(async (selectedTests: BatchTestResult[]) => {
    if (selectedTests.length === 0) return;

    const tests = selectedTests.map(test => ({
      provider: test.provider,
      model: test.model,
      ...(test.keyIndex !== undefined ? { keyIndex: test.keyIndex } : {}),
    }));

    setBatchTestResults(prev => markBatchTestsAsTesting(prev, selectedTests));

    try {
      const result = await api.startBatchTest(tests, batchTestConcurrency);
      if (result.success) {
        setIsBatchTesting(true);
        showToast(
          t("batch_test.started", { total: result.total, concurrency: result.concurrency }),
          "success",
          3000
        );
        await pollBatchTestStatus();
        startBatchTestPolling();
      } else {
        showToast(result.error || t("batch_test.start_failed"), "error", 5000);
      }
    } catch (err: any) {
      if (err.status === 409) {
        showToast(t("batch_test.already_running"), "warning", 5000);
      } else {
        showToast(err.message || t("batch_test.start_failed"), "error", 5000);
      }
      await pollBatchTestStatus();
    }
  }, [batchTestConcurrency, pollBatchTestStatus, showToast, startBatchTestPolling, t]);

  const handleCancelBatchTest = useCallback(async () => {
    try {
      const result = await api.cancelBatchTest();
      if (result.success) {
        showToast(
          t("batch_test.cancelled", { completed: result.completed, cancelled: result.cancelled }),
          "warning",
          5000
        );
        await pollBatchTestStatus();
      }
    } catch (err: any) {
      showToast(err.message || t("batch_test.cancel_failed"), "error", 5000);
    }
  }, [pollBatchTestStatus, showToast, t]);

  const handleClearBatchTestResults = useCallback(async () => {
    try {
      await api.clearBatchTestResults();
      setBatchTestResults([]);
      setBatchTestStartedAt(null);
      setBatchTestCompletedAt(null);
      setBatchTestTitle(t("batch_test.title"));
      showToast(t("batch_test.clear_results_success"), "success");
    } catch (err: any) {
      showToast(err?.message || t("batch_test.clear_results_failed"), "error", 5000);
    }
  }, [showToast, t]);

  const handleProviderBatchResultsCleared = useCallback((provider: string) => {
    setBatchTestResults(prev => {
      const next = filterProviderBatchTestResults(prev, provider);
      if (next.length === 0) {
        setBatchTestStartedAt(null);
        setBatchTestCompletedAt(null);
      }
      return next;
    });
  }, []);

  const handleBatchTestModelValues = useCallback((values: string[], title?: string) => {
    const providers = Array.isArray(config?.Providers) ? config.Providers : [];
    const groups = Array.isArray(config?.ModelGroups) ? config.ModelGroups : [];
    void handleOpenBatchTest(
      buildBatchTestsForModelValues(values, providers, groups),
      title
    );
  }, [config?.ModelGroups, config?.Providers, handleOpenBatchTest]);

  const handleBatchTestRouterModels = useCallback(() => {
    handleBatchTestModelValues(
      getSelectedRouterModelValues(config?.Router),
      t("router.batch_test_title")
    );
  }, [config?.Router, handleBatchTestModelValues, t]);

  useEffect(() => {
    api.getBatchTestStatus().then(status => {
      if (status.results?.length > 0) {
        setBatchTestResults(prev => mergeBatchTestResults(prev, status.results));
      }
      if (status.concurrency) {
        setBatchTestConcurrency(status.concurrency);
      }
      if (status.startedAt !== undefined) {
        setBatchTestStartedAt(status.startedAt);
      }
      if (status.completedAt !== undefined) {
        setBatchTestCompletedAt(status.completedAt);
      }
      if (status.status === "running" || status.status === "cancelling") {
        setIsBatchTesting(true);
        setShowBatchTestDialog(true);
        startBatchTestPolling();
      } else if (!status.results?.length) {
        api.getBatchTestResults().then(data => {
          if (data?.results?.length > 0) {
            setBatchTestResults(data.results);
            setBatchTestStartedAt(data.startedAt ?? null);
            setBatchTestCompletedAt(data.completedAt ?? null);
          }
        }).catch(() => {});
      }
    }).catch(err => {
      console.error("Failed to load batch test status:", err);
      api.getBatchTestResults().then(data => {
        if (data?.results?.length > 0) {
          setBatchTestResults(data.results);
          setBatchTestStartedAt(data.startedAt ?? null);
          setBatchTestCompletedAt(data.completedAt ?? null);
        }
      }).catch(() => {});
    });

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [startBatchTestPolling]);

  // Restart service - wait for pending auto-save to complete
  const restartService = async () => {
    if (!config) {
      showToast(t('app.config_missing'), 'error');
      return;
    }

    // Prevent double-click
    if (isRestarting) return;

    // Wait for pending auto-save to complete
    if (isSaving) {
      showToast(t('app.waiting_for_save'), 'warning');
      // Wait up to 3 seconds for save to complete (debounce is 2s + 1s buffer)
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    setIsRestarting(true);

    try {
      // Connect to restart status SSE first
      const statusEventSource = new EventSource('/api/restart/status');
      let serviceStopped = false;

      statusEventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'restart_preparing') {
            showToast(t('app.restart_preparing') || 'Service is preparing to restart...', 'info');
          } else if (data.type === 'service_stopping') {
            showToast(t('app.service_stopping') || 'Service is stopping, please wait...', 'warning');
            serviceStopped = true;
            statusEventSource.close();

            // Start polling for service recovery
            pollForServiceRecovery();
          }
        } catch (e) {
          console.error('Failed to parse restart status:', e);
        }
      };

      statusEventSource.onerror = () => {
        statusEventSource.close();
        // Server connection lost before service_stopping was received
        // This means the server was killed - start polling for recovery as fallback
        if (!serviceStopped) {
          serviceStopped = true;
          pollForServiceRecovery();
        }
      };

      // Call restart API
      const response = await api.restartService();
      console.log('Restart initiated:', response);

    } catch (error) {
      console.error('Failed to restart service:', error);
      showToast(t('app.restart_failed') + ': ' + (error as Error).message, 'error');
      setIsRestarting(false);
    }
  };

  // Poll for service recovery after restart
  const pollForServiceRecovery = () => {
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max (1s interval)

    const checkService = setInterval(async () => {
      attempts++;
      try {
        // Try to fetch config to check if service is back
        const response = await fetch('/api/config');
        if (response.ok) {
          clearInterval(checkService);
          setIsRestarting(false);
          showToast(t('app.restart_success') || 'Service restarted successfully!', 'success');
          // Reload the page to refresh all data
          setTimeout(() => window.location.reload(), 500);
        }
      } catch (e) {
        // Service not ready yet
        if (attempts >= maxAttempts) {
          clearInterval(checkService);
          setIsRestarting(false);
          showToast(t('app.restart_timeout') || 'Restart timeout, please refresh manually', 'error');
        }
      }
    }, 1000);
  };
  
  // 检查更新函数
  const checkForUpdates = useCallback(async (showDialog: boolean = true) => {
    // 如果已经检查过且有新版本，根据参数决定是否显示对话框
    if (hasCheckedUpdate && isNewVersionAvailable) {
      if (showDialog) {
        setIsUpdateDialogOpen(true);
      }
      return;
    }
    
    setIsCheckingUpdate(true);
    try {
      const updateInfo = await api.checkForUpdates();
      
      if (updateInfo.hasUpdate && updateInfo.latestVersion && updateInfo.changelog) {
        setIsNewVersionAvailable(true);
        setNewVersionInfo({
          version: updateInfo.latestVersion,
          changelog: updateInfo.changelog
        });
        // 只有在showDialog为true时才显示对话框
        if (showDialog) {
          setIsUpdateDialogOpen(true);
        }
      } else if (showDialog) {
        // 只有在showDialog为true时才显示没有更新的提示
        showToast(t('app.no_updates_available'), 'success');
      }
      
      setHasCheckedUpdate(true);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      setIsUpdateFeatureAvailable(false);
      if (showDialog) {
        showToast(t('app.update_check_failed') + ': ' + (error as Error).message, 'error');
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [hasCheckedUpdate, isNewVersionAvailable, t, showToast]);

  useEffect(() => {
    const checkAuth = async () => {
      // If we already have a config, we're authenticated
      if (config) {
        setIsCheckingAuth(false);
        // 自动检查更新，但不显示对话框
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
        return;
      }
      
      // For empty API key, allow access without checking config
      const apiKey = localStorage.getItem('apiKey');
      if (!apiKey) {
        setIsCheckingAuth(false);
        return;
      }
      
      // If we don't have a config, try to fetch it
      try {
        await api.getConfig();
        // If successful, we don't need to do anything special
        // The ConfigProvider will handle setting the config
      } catch (err) {
        // If it's a 401, the API client will redirect to login
        // For other errors, we still show the app to display the error
        console.error('Error checking auth:', err);
        // Redirect to login on authentication error
        if ((err as Error).message === 'Unauthorized') {
          navigate('/login');
        }
      } finally {
        setIsCheckingAuth(false);
        // 在获取配置完成后检查更新，但不显示对话框
        if (!hasCheckedUpdate && !hasAutoCheckedUpdate.current) {
          hasAutoCheckedUpdate.current = true;
          checkForUpdates(false);
        }
      }
    };

    checkAuth();
    
    // Listen for unauthorized events
    const handleUnauthorized = () => {
      navigate('/login');
    };
    
    window.addEventListener('unauthorized', handleUnauthorized);
    
    return () => {
      window.removeEventListener('unauthorized', handleUnauthorized);
    };
  }, [config, navigate, hasCheckedUpdate, checkForUpdates]);
  
  // 执行更新函数
  const performUpdate = async () => {
    if (!newVersionInfo) return;

    try {
      const result = await api.performUpdate();

      if (result.success) {
        showToast(t('app.update_successful'), 'success');
        setIsNewVersionAvailable(false);
        setIsUpdateDialogOpen(false);
        setHasCheckedUpdate(false); // 重置检查状态，以便下次重新检查
      } else {
        showToast(t('app.update_failed') + ': ' + result.message, 'error');
      }
    } catch (error) {
      console.error('Failed to perform update:', error);
      showToast(t('app.update_failed') + ': ' + (error as Error).message, 'error');
    }
  };

  
  if (isCheckingAuth) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-gray-500">Loading application...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-red-500">Error: {error.message}</div>
      </div>
    );
  }

  // Handle case where config is null or undefined
  if (!config) {
    return (
      <div className="h-screen bg-gray-50 font-sans flex items-center justify-center">
        <div className="text-gray-500">Loading configuration...</div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="h-screen bg-gray-50 font-sans">
      <header className="flex h-14 md:h-16 items-center justify-between border-b bg-white px-2 md:px-4">
        {/* Left side - Title and Mobile Menu */}
        <div className="flex items-center gap-2">
          <h1 className="text-base md:text-lg font-semibold text-gray-800">{t('app.title')}</h1>
          
          {/* Desktop Panel Toggles */}
          <div className="hidden lg:flex items-center gap-1 border-l pl-4 ml-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showProviders ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowProviders(!showProviders)}
                  className="transition-all-ease hover:scale-[1.02]"
                >
                  <Server className="h-4 w-4 mr-1.5" />
                  {t('navbar.providers')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('navbar.tooltip_providers')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showRouter ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowRouter(!showRouter)}
                  className="transition-all-ease hover:scale-[1.02]"
                >
                  <Route className="h-4 w-4 mr-1.5" />
                  {t('navbar.router')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('navbar.tooltip_router')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showTransformers ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowTransformers(!showTransformers)}
                  className="transition-all-ease hover:scale-[1.02]"
                >
                  <Workflow className="h-4 w-4 mr-1.5" />
                  {t('navbar.transformers')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('navbar.tooltip_transformers')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showModelGroups ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowModelGroups(!showModelGroups)}
                  className="transition-all-ease hover:scale-[1.02]"
                >
                  <Layers className="h-4 w-4 mr-1.5" />
                  {t('navbar.groups')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('navbar.tooltip_groups')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showModelMonitor ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setShowModelMonitor(!showModelMonitor)}
                  className="transition-all-ease hover:scale-[1.02]"
                >
                  <Activity className="h-4 w-4 mr-1.5" />
                  {t('navbar.monitor')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('navbar.tooltip_monitor')}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Right side - System Controls */}
        <div className="flex items-center gap-1 md:gap-2">
          {/* Mobile Menu Button */}
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          
          {/* Desktop Controls */}
          <div className="hidden md:flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(true)} className="transition-all-ease hover:scale-110">
                  <Settings className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.settings')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setIsJsonEditorOpen(true)} className="transition-all-ease hover:scale-110">
                  <FileJson className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.json_editor')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setIsLogViewerOpen(true)} className="transition-all-ease hover:scale-110">
                  <FileText className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.log_viewer')}</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => navigate('/presets')} className="transition-all-ease hover:scale-110">
                  <FileCog className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('app.presets')}</p>
              </TooltipContent>
            </Tooltip>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="transition-all-ease hover:scale-110">
                  <Languages className="h-5 w-5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-32 p-2">
                <div className="space-y-1">
                  <Button
                    variant={i18n.language.startsWith('en') ? 'default' : 'ghost'}
                    className="w-full justify-start transition-all-ease hover:scale-[1.02]"
                    onClick={() => i18n.changeLanguage('en')}
                  >
                    {t('app.language_english')}
                  </Button>
                  <Button
                    variant={i18n.language.startsWith('zh') ? 'default' : 'ghost'}
                    className="w-full justify-start transition-all-ease hover:scale-[1.02]"
                    onClick={() => i18n.changeLanguage('zh')}
                  >
                    {t('app.language_chinese')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            {/* 更新版本按钮 - 仅当更新功能可用时显示 */}
            {isUpdateFeatureAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => checkForUpdates(true)}
                    disabled={isCheckingUpdate}
                    className="transition-all-ease hover:scale-110 relative"
                  >
                    <div className="relative">
                      <CircleArrowUp className="h-5 w-5" />
                      {isNewVersionAvailable && !isCheckingUpdate && (
                        <div className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white"></div>
                      )}
                    </div>
                    {isCheckingUpdate && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"></div>
                      </div>
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('app.check_updates')}</p>
                </TooltipContent>
              </Tooltip>
            )}
            <Button onClick={restartService} disabled={isRestarting} className="transition-all-ease hover:scale-[1.02] active:scale-[0.98]">
              <RefreshCw className={`mr-2 h-4 w-4 ${isRestarting ? 'animate-spin' : ''}`} />
              {isRestarting ? (t('app.restarting') || 'Restarting...') : t('app.restart')}
            </Button>
          </div>
          
          {/* Mobile Restart Button */}
          <Button 
            onClick={restartService} 
            disabled={isRestarting} 
            size="sm"
            className="md:hidden transition-all-ease"
          >
            <RefreshCw className={`h-4 w-4 ${isRestarting ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>
      
      {/* Mobile Dropdown Menu */}
      {isMobileMenuOpen && (
        <div className="lg:hidden fixed top-14 left-0 right-0 z-50 bg-white border-b shadow-lg animate-fade-in">
          <div className="p-3 space-y-2 max-h-[calc(100vh-4rem)] overflow-y-auto">
            {/* Panel Toggles */}
            <div className="space-y-1">
              <p className="text-xs font-medium text-gray-500 uppercase px-2">{t('navbar.panels') || 'Panels'}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={showProviders ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setShowProviders(!showProviders); setIsMobileMenuOpen(false); }}
                >
                  <Server className="h-4 w-4 mr-1.5" />
                  {t('navbar.providers')}
                </Button>
                <Button
                  variant={showRouter ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setShowRouter(!showRouter); setIsMobileMenuOpen(false); }}
                >
                  <Route className="h-4 w-4 mr-1.5" />
                  {t('navbar.router')}
                </Button>
                <Button
                  variant={showTransformers ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setShowTransformers(!showTransformers); setIsMobileMenuOpen(false); }}
                >
                  <Workflow className="h-4 w-4 mr-1.5" />
                  {t('navbar.transformers')}
                </Button>
                <Button
                  variant={showModelGroups ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setShowModelGroups(!showModelGroups); setIsMobileMenuOpen(false); }}
                >
                  <Layers className="h-4 w-4 mr-1.5" />
                  {t('navbar.groups')}
                </Button>
                <Button
                  variant={showModelMonitor ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setShowModelMonitor(!showModelMonitor); setIsMobileMenuOpen(false); }}
                >
                  <Activity className="h-4 w-4 mr-1.5" />
                  {t('navbar.monitor')}
                </Button>
              </div>
            </div>
            
            {/* Actions */}
            <div className="space-y-1 pt-2 border-t">
              <p className="text-xs font-medium text-gray-500 uppercase px-2">{t('navbar.actions') || 'Actions'}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => { setIsSettingsOpen(true); setIsMobileMenuOpen(false); }}>
                  <Settings className="h-4 w-4 mr-1.5" />
                  {t('app.settings')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { setIsJsonEditorOpen(true); setIsMobileMenuOpen(false); }}>
                  <FileJson className="h-4 w-4 mr-1.5" />
                  {t('app.json_editor')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { setIsLogViewerOpen(true); setIsMobileMenuOpen(false); }}>
                  <FileText className="h-4 w-4 mr-1.5" />
                  {t('app.log_viewer')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => { navigate('/presets'); setIsMobileMenuOpen(false); }}>
                  <FileCog className="h-4 w-4 mr-1.5" />
                  {t('app.presets')}
                </Button>
              </div>
            </div>
            
            {/* Language */}
            <div className="space-y-1 pt-2 border-t">
              <p className="text-xs font-medium text-gray-500 uppercase px-2">{t('navbar.language') || 'Language'}</p>
              <div className="flex gap-2">
                <Button
                  variant={i18n.language.startsWith('en') ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { i18n.changeLanguage('en'); setIsMobileMenuOpen(false); }}
                >
                  {t('app.language_english')}
                </Button>
                <Button
                  variant={i18n.language.startsWith('zh') ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { i18n.changeLanguage('zh'); setIsMobileMenuOpen(false); }}
                >
                  {t('app.language_chinese')}
                </Button>
              </div>
            </div>
            
            {/* Update */}
            {isUpdateFeatureAvailable && (
              <div className="pt-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => { checkForUpdates(true); setIsMobileMenuOpen(false); }}
                  disabled={isCheckingUpdate}
                >
                  <CircleArrowUp className="h-4 w-4 mr-1.5" />
                  {t('app.check_updates')}
                  {isNewVersionAvailable && (
                    <span className="ml-2 w-2 h-2 bg-red-500 rounded-full" />
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <main className="flex flex-col lg:flex-row h-[calc(100vh-3.5rem)] md:h-[calc(100vh-4rem)] gap-2 md:gap-4 p-2 md:p-4 overflow-hidden">
        {/* Mobile: Stack panels vertically, Desktop: Horizontal layout */}
        {/* Left Column: Providers - full width when no other panel is active */}
        {showProviders && (
          <div className={`flex-1 min-w-0 min-h-0 animate-slide-in ${
            (showRouter || showTransformers || showModelGroups || showModelMonitor)
              ? 'lg:flex-initial lg:w-[480px] lg:min-w-[400px] lg:max-w-[600px]'
              : ''
          }`}>
            <Providers
              showToast={showToast}
              removeToast={removeToast}
              requestStats={requestStats}
              hoveredModel={hoveredModel}
              onBadgeRef={handleBadgeRef}
              onOpenBatchTest={handleOpenBatchTest}
              onProviderResultsCleared={handleProviderBatchResultsCleared}
            />
          </div>
        )}

        {/* Middle Column: Router + Model Groups + Transformers */}
        {(showRouter || showTransformers || showModelGroups) && (
          <div className="flex flex-col flex-1 gap-2 md:gap-4 min-w-0 min-h-0 animate-slide-in">
            {showRouter && (
              <div className="flex-1 min-h-0">
                <Router
                  hoveredModel={hoveredModel}
                  onHoverModel={handleHoverModel}
                  requestStats={requestStats}
                  onBatchTestSelected={handleBatchTestRouterModels}
                />
              </div>
            )}
            {showModelGroups && (
              <div className="flex-1 min-h-0">
                <ModelGroups
                  requestStats={requestStats}
                  hoveredModel={hoveredModel}
                  onHoverModel={handleHoverModel}
                  onBatchTestModels={handleBatchTestModelValues}
                />
              </div>
            )}
            {showTransformers && (
              <div className="flex-1 min-h-0">
                <Transformers />
              </div>
            )}
          </div>
        )}

        {/* Right Column: Model Monitor */}
        {showModelMonitor && (
          <div className="flex-1 lg:w-96 lg:min-w-0 lg:shrink-0 animate-slide-in">
            <ModelMonitorPanel
              logs={modelMonitorLogs}
              status={modelMonitorStatus}
              currentFile={modelMonitorFile}
              onClose={() => setShowModelMonitor(false)}
              onHoverModel={handleHoverModel}
            />
          </div>
        )}
      </main>
      <SettingsDialog isOpen={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
      <JsonEditor
        open={isJsonEditorOpen}
        onOpenChange={setIsJsonEditorOpen}
        showToast={showToast}
      />
      <LogViewer
        open={isLogViewerOpen}
        onOpenChange={setIsLogViewerOpen}
        showToast={showToast}
      />
      <BatchTestDialog
        open={showBatchTestDialog}
        onClose={() => setShowBatchTestDialog(false)}
        results={batchTestResults}
        title={batchTestTitle}
        onRunTests={handleRunBatchTests}
        onRetryTest={(test) => void handleRunBatchTests([test])}
        onCancel={handleCancelBatchTest}
        onClearResults={handleClearBatchTestResults}
        isRunning={isBatchTesting}
        concurrency={batchTestConcurrency}
        onConcurrencyChange={setBatchTestConcurrency}
        startedAt={batchTestStartedAt}
        completedAt={batchTestCompletedAt}
        providerApiUrls={providerApiUrls}
        onTestConnectivity={async (_provider: string, url: string) => {
          const toastId = showToast(t("provider_list.connectivity_testing", { url }), "warning", 0);
          try {
            const result = await api.testConnectivity(url);
            removeToast(toastId);
            if (result?.success) {
              showToast(
                t("provider_list.connectivity_ok", { url, ms: result.latency_ms, status: result.status }),
                "success",
                5000
              );
            } else {
              showToast(
                t("provider_list.connectivity_fail", { url, error: result?.error || "Unknown error" }),
                "error",
                8000
              );
            }
          } catch (err: any) {
            removeToast(toastId);
            showToast(
              t("provider_list.connectivity_fail", { url, error: err?.message || "Network error" }),
              "error",
              5000
            );
          }
        }}
        showToast={showToast}
        onModelRemoved={(provider, model) => {
          setBatchTestResults(prev => filterRemovedBatchTestResult(prev, provider, model));
        }}
        onFailedModelsRemoved={(provider, models) => {
          setBatchTestResults(prev => filterRemovedBatchTestResults(prev, provider, models));
        }}
      />
      <Dialog open={isUpdateDialogOpen} onOpenChange={setIsUpdateDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('app.new_version_available')}
              {newVersionInfo && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  v{newVersionInfo.version}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              {t('app.update_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto py-4">
            {newVersionInfo?.changelog ? (
              <div className="whitespace-pre-wrap text-sm">
                {newVersionInfo.changelog}
              </div>
            ) : (
              <div className="text-muted-foreground">
                {t('app.no_changelog_available')}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsUpdateDialogOpen(false)}
            >
              {t('app.later')}
            </Button>
            <Button onClick={performUpdate}>
              {t('app.update_now')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-h-[calc(100vh-2rem)] overflow-hidden">
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            exiting={toast.exiting}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </div>
    </TooltipProvider>
  );
}

export default App;
