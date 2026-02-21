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
import { Button } from "@/components/ui/button";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";
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
  LayoutDashboard
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
  const [toasts, setToasts] = useState<{ id: string; message: string; type: 'success' | 'error' | 'warning' | 'info'; duration?: number }[]>([]);
  // 版本检查状态
  const [isNewVersionAvailable, setIsNewVersionAvailable] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [newVersionInfo, setNewVersionInfo] = useState<{ version: string; changelog: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [hasCheckedUpdate, setHasCheckedUpdate] = useState(false);
  const [isUpdateFeatureAvailable, setIsUpdateFeatureAvailable] = useState(true);
  const hasAutoCheckedUpdate = useRef(false);

  // Show toast function with max limit
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info', duration?: number) => {
    const id = Date.now() + Math.random().toString(36).substring(2);
    setToasts(prev => {
      // Keep only the last 4 toasts, remove oldest if exceeds limit
      const newToasts = [...prev, { id, message, type, duration }];
      if (newToasts.length > 5) {
        return newToasts.slice(-5);
      }
      return newToasts;
    });
    return id;
  }, []);

  // Update toast message in-place (for progress indicators)
  const updateToast = useCallback((id: string, message: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, message } : t));
  }, []);

  // Remove toast function
  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

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
      <header className="flex h-16 items-center justify-between border-b bg-white px-4">
        {/* Left side - Panel Toggles */}
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-800 mr-4">{t('app.title')}</h1>
          <div className="flex items-center gap-1 border-r pr-4 mr-2">
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
        <div className="flex items-center gap-2">
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
      </header>

      <main className="flex h-[calc(100vh-4rem)] gap-4 p-4 overflow-hidden">
        {/* Left Column: Providers */}
        {showProviders && (
          <div className="flex-1 min-w-0 animate-slide-in">
            <Providers
              showToast={showToast}
              updateToast={updateToast}
              removeToast={removeToast}
              hoveredModel={hoveredModel}
              onBadgeRef={handleBadgeRef}
            />
          </div>
        )}

        {/* Middle Column: Router + Model Groups + Transformers */}
        {(showRouter || showTransformers || showModelGroups) && (
          <div className="flex flex-1 flex-col gap-4 min-w-0 animate-slide-in">
            {showRouter && (
              <div className="flex-1 min-h-0">
                <Router hoveredModel={hoveredModel} onHoverModel={handleHoverModel} requestStats={requestStats} />
              </div>
            )}
            {showModelGroups && (
              <div className="flex-1 min-h-0">
                <ModelGroups requestStats={requestStats} hoveredModel={hoveredModel} onHoverModel={handleHoverModel} />
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
          <div className="w-96 min-w-0 animate-slide-in shrink-0">
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
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            message={toast.message}
            type={toast.type}
            duration={toast.duration}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </div>
    </TooltipProvider>
  );
}

export default App;
