import { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { ReactNode, Dispatch, SetStateAction } from 'react';
import { api } from '@/lib/api';
import type { Config, StatusLineConfig } from '@/types';

interface ConfigContextType {
  config: Config | null;
  setConfig: Dispatch<SetStateAction<Config | null>>;
  error: Error | null;
  isSaving: boolean;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

interface ConfigProviderProps {
  children: ReactNode;
}

export function ConfigProvider({ children }: ConfigProviderProps) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [hasFetched, setHasFetched] = useState<boolean>(false);
  const [apiKey, setApiKey] = useState<string | null>(localStorage.getItem('apiKey'));
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Refs for auto-save and external update tracking
  const isExternalUpdateRef = useRef<boolean>(false);
  const pendingSaveRef = useRef<NodeJS.Timeout | null>(null);
  const lastServerConfigRef = useRef<Config | null>(null);

  // Listen for localStorage changes
  useEffect(() => {
    const handleStorageChange = () => {
      setApiKey(localStorage.getItem('apiKey'));
    };

    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    const fetchConfig = async () => {
      // Reset fetch state when API key changes
      setHasFetched(false);
      setConfig(null);
      setError(null);
    };

    fetchConfig();
  }, [apiKey]);

  useEffect(() => {
    const fetchConfig = async () => {
      // Prevent duplicate API calls in React StrictMode
      // Skip if we've already fetched
      if (hasFetched) {
        return;
      }
      setHasFetched(true);
      
      try {
        // Try to fetch config regardless of API key presence
        const data = await api.getConfig();
        
        // Validate the received data to ensure it has the expected structure
        const validConfig = {
          noAuth: typeof data.noAuth === 'boolean' ? data.noAuth : false,
          LOG: typeof data.LOG === 'boolean' ? data.LOG : false,
          LOG_LEVEL: typeof data.LOG_LEVEL === 'string' ? data.LOG_LEVEL : 'debug',
          CLAUDE_PATH: typeof data.CLAUDE_PATH === 'string' ? data.CLAUDE_PATH : '',
          HOST: typeof data.HOST === 'string' ? data.HOST : '127.0.0.1',
          PORT: typeof data.PORT === 'number' ? data.PORT : 3456,
          APIKEY: typeof data.APIKEY === 'string' ? data.APIKEY : '',
          API_TIMEOUT_MS: typeof data.API_TIMEOUT_MS === 'string' ? data.API_TIMEOUT_MS : '600000',
          PROXY_URL: typeof data.PROXY_URL === 'string' ? data.PROXY_URL : '',
          TEST_PROMPT: typeof data.TEST_PROMPT === 'string' ? data.TEST_PROMPT : '',
          transformers: Array.isArray(data.transformers) ? data.transformers : [],
          Providers: Array.isArray(data.Providers) ? data.Providers : [],
          StatusLine: data.StatusLine && typeof data.StatusLine === 'object' ? {
            enabled: typeof data.StatusLine.enabled === 'boolean' ? data.StatusLine.enabled : false,
            currentStyle: typeof data.StatusLine.currentStyle === 'string' ? data.StatusLine.currentStyle : 'default',
            default: data.StatusLine.default && typeof data.StatusLine.default === 'object' && Array.isArray(data.StatusLine.default.modules) ? data.StatusLine.default : { modules: [] },
            powerline: data.StatusLine.powerline && typeof data.StatusLine.powerline === 'object' && Array.isArray(data.StatusLine.powerline.modules) ? data.StatusLine.powerline : { modules: [] }
          } : { 
            enabled: false,
            currentStyle: 'default',
            default: { modules: [] },
            powerline: { modules: [] }
          },
          Router: data.Router && typeof data.Router === 'object' ? {
            default: typeof data.Router.default === 'string' ? data.Router.default : '',
            background: typeof data.Router.background === 'string' ? data.Router.background : '',
            think: typeof data.Router.think === 'string' ? data.Router.think : '',
            longContext: typeof data.Router.longContext === 'string' ? data.Router.longContext : '',
            longContextThreshold: typeof data.Router.longContextThreshold === 'number' ? data.Router.longContextThreshold : 60000,
            webSearch: typeof data.Router.webSearch === 'string' ? data.Router.webSearch : '',
            image: typeof data.Router.image === 'string' ? data.Router.image : '',
            compact: typeof data.Router.compact === 'string' ? data.Router.compact : ''
          } : {
            default: '',
            background: '',
            think: '',
            longContext: '',
            longContextThreshold: 60000,
            webSearch: '',
            image: '',
            compact: ''
          },
          CUSTOM_ROUTER_PATH: typeof data.CUSTOM_ROUTER_PATH === 'string' ? data.CUSTOM_ROUTER_PATH : ''
        };
        
        setConfig(validConfig);
      } catch (err) {
        console.error('Failed to fetch config:', err);
        // If we get a 401, the API client will redirect to login
        // Otherwise, set an empty config or error
        if ((err as Error).message !== 'Unauthorized') {
          // Set default empty config when fetch fails
          setConfig({
            LOG: false,
            LOG_LEVEL: 'debug',
            CLAUDE_PATH: '',
            HOST: '127.0.0.1',
            PORT: 3456,
            APIKEY: '',
            API_TIMEOUT_MS: '600000',
            PROXY_URL: '',
            TEST_PROMPT: '',
            transformers: [],
            Providers: [],
            StatusLine: undefined,
            Router: {
              default: '',
              background: '',
              think: '',
              longContext: '',
              longContextThreshold: 60000,
              webSearch: '',
              image: '',
              compact: ''
            },
            CUSTOM_ROUTER_PATH: ''
          });
          setError(err as Error);
        }
      }
    };

    fetchConfig();
  }, [hasFetched, apiKey]);

  // Auto-save with debounce (2 seconds)
  useEffect(() => {
    if (!config || isExternalUpdateRef.current) {
      isExternalUpdateRef.current = false;
      return;
    }

    // Clear previous pending save
    if (pendingSaveRef.current) {
      clearTimeout(pendingSaveRef.current);
    }

    setIsSaving(true);

    // Debounce save by 2 seconds
    pendingSaveRef.current = setTimeout(async () => {
      try {
        await api.updateConfig(config);
        lastServerConfigRef.current = config;
      } catch (error) {
        console.error('Auto-save failed:', error);
      } finally {
        setIsSaving(false);
      }
    }, 2000);

    return () => {
      if (pendingSaveRef.current) {
        clearTimeout(pendingSaveRef.current);
        setIsSaving(false);
      }
    };
  }, [config]);

  // SSE listener for external config updates with auto-reconnect
  useEffect(() => {
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    let eventSource: EventSource | null = null;
    let reconnectTimeoutId: NodeJS.Timeout | null = null;

    const createEventSource = (): EventSource | null => {
      if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('Max SSE reconnection attempts reached');
        return null;
      }

      console.log(`Creating SSE connection (attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})...`);
      const es = new EventSource('/api/config/stream');

      es.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'config_update') {
            isExternalUpdateRef.current = true;
            setConfig(message.data);
            lastServerConfigRef.current = message.data;
          }
        } catch (error) {
          console.error('Failed to parse SSE message:', error);
        }
      };

      es.onerror = (error) => {
        console.error('SSE connection error:', error);
        es.close();

        // Attempt to reconnect with exponential backoff
        reconnectAttempts++;
        if (reconnectAttempts < maxReconnectAttempts) {
          const delay = Math.min(reconnectAttempts * 1000, 5000);
          console.log(`Will attempt to reconnect in ${delay}ms...`);
          reconnectTimeoutId = setTimeout(() => {
            eventSource = createEventSource();
          }, delay);
        } else {
          console.error('Max reconnection attempts reached, stopping reconnection');
        }
      };

      es.onopen = () => {
        console.log('SSE connection established');
        reconnectAttempts = 0; // Reset on successful connection
      };

      return es;
    };

    eventSource = createEventSource();

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      if (reconnectTimeoutId) {
        clearTimeout(reconnectTimeoutId);
      }
    };
  }, []);

  return (
    <ConfigContext.Provider value={{ config, setConfig, error, isSaving }}>
      {children}
    </ConfigContext.Provider>
  );
}
