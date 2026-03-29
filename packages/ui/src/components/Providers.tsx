import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfig } from "./ConfigProvider";
import { ProviderList } from "./ProviderList";
import { useRequestStats } from "@/hooks/useRequestStats";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Trash2, Plus, Eye, EyeOff, Search, XCircle, Play, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ComboInput } from "@/components/ui/combo-input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { getRequestStatus, getStatusBadgeClasses } from "@/lib/requestStatus";
import type { Provider, ApiKeyEntry, ApiKeyConfig } from "@/types";
import { BatchTestDialog } from "./BatchTestDialog";
import { NewApiAssignmentDialog } from "./NewApiAssignmentDialog";
import type { BatchTestResult } from "./BatchTestDialog";

const getBatchTestResultKey = (result: { provider: string; model: string; keyIndex?: number }) => {
  return result.keyIndex !== undefined
    ? `${result.provider}-${result.model}-key${result.keyIndex}`
    : `${result.provider}-${result.model}`;
};

const mergeBatchTestResults = (prev: BatchTestResult[], incoming: BatchTestResult[]) => {
  const incomingMap = new Map(incoming.map(result => [getBatchTestResultKey(result), result]));
  const merged = prev.map(result => incomingMap.get(getBatchTestResultKey(result)) || result);
  const existingKeys = new Set(prev.map(result => getBatchTestResultKey(result)));
  const appended = incoming.filter(result => !existingKeys.has(getBatchTestResultKey(result)));
  return [...merged, ...appended];
};

const markBatchTestsAsTesting = (prev: BatchTestResult[], selectedTests: BatchTestResult[]): BatchTestResult[] => {
  if (selectedTests.length === 0) return prev;
  const selectedKeys = new Set(selectedTests.map(getBatchTestResultKey));
  return prev.map(result => {
    if (!selectedKeys.has(getBatchTestResultKey(result))) {
      return result;
    }
    return {
      ...result,
      status: "testing" as const,
      message: undefined,
      response: undefined,
      timestamp: Date.now(),
    };
  });
};

const mergePersistedBatchTests = (allTests: Array<{ provider: string; model: string; keyIndex?: number }>, persistedResults: BatchTestResult[]) => {
  const persistedMap = new Map<string, BatchTestResult>();
  for (const result of persistedResults) {
    persistedMap.set(getBatchTestResultKey(result), result);
  }
  return allTests.map(({ provider, model, keyIndex }) => {
    const key = getBatchTestResultKey({ provider, model, keyIndex });
    return persistedMap.get(key) || { provider, model, ...(keyIndex !== undefined ? { keyIndex } : {}), status: "idle" as const };
  });
};

const buildFreshBatchTests = (allTests: Array<{ provider: string; model: string; keyIndex?: number }>) => {
  return allTests.map(({ provider, model, keyIndex }) => ({
    provider,
    model,
    ...(keyIndex !== undefined ? { keyIndex } : {}),
    status: "idle" as const,
  }));
};

const filterRemovedBatchTestResult = (
  results: BatchTestResult[],
  provider: string,
  model: string
) => results.filter(result => !(result.provider === provider && result.model === model));

const filterRemovedBatchTestResults = (
  results: BatchTestResult[],
  provider: string,
  models: string[]
) => {
  const removedModelSet = new Set(models);
  return results.filter(result => !(result.provider === provider && removedModelSet.has(result.model)));
};

// Model data from /v1/models endpoint
interface ModelData {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ProviderType extends Provider {}

export function Providers({
  showToast,
  updateToast,
  removeToast,
  hoveredModel,
  onBadgeRef
}: {
  showToast: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  updateToast: (id: string, message: string) => void;
  removeToast: (id: string) => void;
  hoveredModel?: { provider: string | null; model: string | null } | null | undefined;
  onBadgeRef?: (provider: string, model: string, ref: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const { config, setConfig, flushSave } = useConfig();
  const [editingProviderIndex, setEditingProviderIndex] = useState<number | null>(null);
  const [deletingProviderIndex, setDeletingProviderIndex] = useState<number | null>(null);
  const [hasFetchedModels, setHasFetchedModels] = useState<Record<number, boolean>>({});
  const [providerParamInputs, setProviderParamInputs] = useState<Record<string, {name: string, value: string}>>({});
  const [modelParamInputs, setModelParamInputs] = useState<Record<string, {name: string, value: string}>>({});
  const [availableTransformers, setAvailableTransformers] = useState<{name: string; endpoint: string | null;}[]>([]);
  const [editingProviderData, setEditingProviderData] = useState<ProviderType | null>(null);
  const [isNewProvider, setIsNewProvider] = useState<boolean>(false);
  const [providerTemplates, setProviderTemplates] = useState<ProviderType[]>([]);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const comboInputRef = useRef<HTMLInputElement>(null);
  const [modelInput, setModelInput] = useState<string>("");
  const [keyModelInputs, setKeyModelInputs] = useState<Record<number, string>>({});

  // Model fetching state
  const [isFetchingModels, setIsFetchingModels] = useState<boolean>(false);
  const [fetchedModels, setFetchedModels] = useState<ModelData[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [showModelSelectDialog, setShowModelSelectDialog] = useState<boolean>(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [modelSearchTerm, setModelSearchTerm] = useState<string>("");
  const [targetKeyIndex, setTargetKeyIndex] = useState<number>(0); // Which key to add models to

  // NewAPI assignment state
  const [showNewApiAssignment, setShowNewApiAssignment] = useState<boolean>(false);
  const [newApiPricingData, setNewApiPricingData] = useState<any>(null);

  // Batch test state
  const [showBatchTestDialog, setShowBatchTestDialog] = useState<boolean>(false);
  const [batchTestResults, setBatchTestResults] = useState<BatchTestResult[]>([]);
  const [isBatchTesting, setIsBatchTesting] = useState<boolean>(false);
  const [batchTestConcurrency, setBatchTestConcurrency] = useState<number>(20);
  const [batchTestStartedAt, setBatchTestStartedAt] = useState<number | null>(null);
  const [batchTestCompletedAt, setBatchTestCompletedAt] = useState<number | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll backend batch test status
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
      if (status.status === 'running' || status.status === 'cancelling') {
        setIsBatchTesting(true);
      } else {
        setIsBatchTesting(false);
        // Stop polling when task is no longer running
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch (e) {
      console.error('Failed to poll batch test status:', e);
    }
  }, []);

  // Start polling interval
  const startPolling = useCallback(() => {
    if (pollTimerRef.current) return; // Already polling
    pollTimerRef.current = setInterval(pollBatchTestStatus, 2000);
  }, [pollBatchTestStatus]);

  // On mount: check if a batch test is running, load results
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
      if (status.status === 'running' || status.status === 'cancelling') {
        setIsBatchTesting(true);
        setShowBatchTestDialog(true);
        startPolling();
      } else if (status.status === 'idle' || status.status === 'completed') {
        // Try to load persisted results if no results from status
        if (!status.results?.length) {
          api.getBatchTestResults().then(data => {
            if (data?.results?.length > 0) {
              setBatchTestResults(data.results);
            }
          }).catch(() => {});
        }
      }
    }).catch(e => {
      console.error('Failed to load batch test status:', e);
      // Fallback: try to load persisted results
      api.getBatchTestResults().then(data => {
        if (data?.results?.length > 0) {
          setBatchTestResults(data.results);
        }
      }).catch(() => {});
    });

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [startPolling]);

  // Get request statistics
  const { stats: requestStats } = useRequestStats();

  useEffect(() => {
    const fetchProviderTemplates = async () => {
      try {
        const response = await fetch('https://pub-0dc3e1677e894f07bbea11b17a29e032.r2.dev/providers.json');
        if (response.ok) {
          const data = await response.json();
          setProviderTemplates(data || []);
        } else {
          console.error('Failed to fetch provider templates');
        }
      } catch (error) {
        console.error('Failed to fetch provider templates:', error);
      }
    };

    fetchProviderTemplates();
  }, []);

  // Fetch available transformers when component mounts
  useEffect(() => {
    const fetchTransformers = async () => {
      try {
        const response = await api.get<{transformers: {name: string; endpoint: string | null;}[]}>('/transformers');
        setAvailableTransformers(response.transformers);
      } catch (error) {
        console.error('Failed to fetch transformers:', error);
      }
    };

    fetchTransformers();
  }, []);

  // Handle case where config is null or undefined
  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b p-4">
          <CardTitle className="text-lg">{t("providers.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading providers configuration...</div>
        </CardContent>
      </Card>
    );
  }

  // Validate config.Providers to ensure it's an array
  const validProviders = Array.isArray(config.Providers) ? config.Providers : [];


  const handleAddProvider = () => {
    const newProvider: ProviderType = { name: "", api_base_url: "", api_key: "", models: [] };
    setEditingProviderIndex(config.Providers.length);
    setEditingProviderData(newProvider);
    setIsNewProvider(true);
    // Reset API key visibility and error when adding new provider
    setShowApiKey(prev => ({
      ...prev,
      [config.Providers.length]: false
    }));
    setApiKeyError(null);
    setNameError(null);
  };

  const handleEditProvider = (index: number) => {
    // Find the actual index in the original providers array
    // Since providers are sorted in UI but not in config, we need to map the sorted provider back to original
    const sortedProvider = sortedProviders[index];
    const actualIndex = validProviders.indexOf(sortedProvider);

    if (actualIndex === -1) {
      console.error("Could not find provider in original list", sortedProvider);
      return;
    }

    const provider = config.Providers[actualIndex];
    setEditingProviderIndex(actualIndex);
    setEditingProviderData(JSON.parse(JSON.stringify(provider))); // 深拷贝
    setIsNewProvider(false);
    // Reset API key visibility and error when opening edit dialog
    setShowApiKey(prev => ({
      ...prev,
      [actualIndex]: false
    }));
    setApiKeyError(null);
    setNameError(null);
  };

  const handleSaveProvider = async () => {
    if (!editingProviderData) return;
    
    // Validate name
    if (!editingProviderData.name || editingProviderData.name.trim() === '') {
      setNameError(t("providers.name_required"));
      return;
    }
    
    // Check for duplicate names (case-insensitive)
    const trimmedName = editingProviderData.name.trim();
    const isDuplicate = config.Providers.some((provider, index) => {
      // For edit mode, skip checking the current provider being edited
      if (!isNewProvider && index === editingProviderIndex) {
        return false;
      }
      return provider.name.toLowerCase() === trimmedName.toLowerCase();
    });
    
    if (isDuplicate) {
      setNameError(t("providers.name_duplicate"));
      return;
    }
    
    // Validate API key - support single string, array of strings, or mixed with ApiKeyEntry
    const apiKeys = Array.isArray(editingProviderData.api_key)
      ? editingProviderData.api_key
      : [editingProviderData.api_key];

    if (!apiKeys.some(k => {
      if (typeof k === 'string') return k && k.trim() !== '';
      if (k && typeof k === 'object') return k.key && k.key.trim() !== '';
      return false;
    })) {
      setApiKeyError(t("providers.api_key_required"));
      return;
    }
    
    // Clear errors if validation passes
    setApiKeyError(null);
    setNameError(null);
    
    if (editingProviderIndex !== null && editingProviderData) {
      const newProviders = [...config.Providers];
      if (isNewProvider) {
        newProviders.push(editingProviderData);
      } else {
        newProviders[editingProviderIndex] = editingProviderData;
      }
      const newConfig = { ...config, Providers: newProviders };
      setConfig(newConfig);
      // Immediately flush to server so models are available for testing
      await flushSave(newConfig);
    }
    // Reset API key visibility for this provider
    if (editingProviderIndex !== null) {
      setShowApiKey(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
    }
    setEditingProviderIndex(null);
    setEditingProviderData(null);
    setIsNewProvider(false);
  };

  const handleCancelAddProvider = () => {
    // Reset fetched models state for this provider
    if (editingProviderIndex !== null) {
      setHasFetchedModels(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
      // Reset API key visibility for this provider
      setShowApiKey(prev => {
        const newState = { ...prev };
        delete newState[editingProviderIndex];
        return newState;
      });
    }
    setEditingProviderIndex(null);
    setEditingProviderData(null);
    setIsNewProvider(false);
    setApiKeyError(null);
    setNameError(null);
  };

  // Handle deletion by setting the correct index in the state
  const handleSetDeletingProviderIndex = (filteredIndex: number) => {
    setDeletingProviderIndex(filteredIndex);
  };

  // Handle deletion by passing the filtered index to get the actual index in the original array
  const handleRemoveProvider = (filteredIndex: number) => {
    // Find the actual index in the original providers array
    // Since providers are sorted in UI but not in config, we need to map the sorted provider back to original
    const sortedProvider = sortedProviders[filteredIndex];
    const actualIndex = validProviders.indexOf(sortedProvider);

    if (actualIndex === -1) {
      console.error("Could not find provider in original list", sortedProvider);
      return;
    }

    const newProviders = [...config.Providers];
    newProviders.splice(actualIndex, 1);
    setConfig({ ...config, Providers: newProviders });
    setDeletingProviderIndex(null);
  };

  const handleProviderChange = (_index: number, field: string, value: string | string[] | (string | ApiKeyEntry)[]) => {
    if (editingProviderData) {
      const updatedProvider = { ...editingProviderData, [field]: value };
      setEditingProviderData(updatedProvider);
    }
  };

  const handleProviderTransformerChange = (_index: number, transformerPath: string) => {
    if (!transformerPath || !editingProviderData) return; // Don't add empty transformers
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Add transformer to the use array
    updatedProvider.transformer.use = [...updatedProvider.transformer.use, transformerPath];
    setEditingProviderData(updatedProvider);
  };

  const removeProviderTransformerAtIndex = (_index: number, transformerIndex: number) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (updatedProvider.transformer) {
      const newUseArray = [...updatedProvider.transformer.use];
      newUseArray.splice(transformerIndex, 1);
      updatedProvider.transformer.use = newUseArray;
      
      // If use array is now empty and no other properties, remove transformer entirely
      if (newUseArray.length === 0 && Object.keys(updatedProvider.transformer).length === 1) {
        delete updatedProvider.transformer;
      }
    }
    
    setEditingProviderData(updatedProvider);
  };

  const handleModelTransformerChange = (_providerIndex: number, model: string, transformerPath: string) => {
    if (!transformerPath || !editingProviderData) return; // Don't add empty transformers
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Initialize model transformer if it doesn't exist
    if (!updatedProvider.transformer[model]) {
      updatedProvider.transformer[model] = { use: [] };
    }
    
    // Add transformer to the use array
    updatedProvider.transformer[model].use = [...updatedProvider.transformer[model].use, transformerPath];
    setEditingProviderData(updatedProvider);
  };

  const removeModelTransformerAtIndex = (_providerIndex: number, model: string, transformerIndex: number) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (updatedProvider.transformer && updatedProvider.transformer[model]) {
      const newUseArray = [...updatedProvider.transformer[model].use];
      newUseArray.splice(transformerIndex, 1);
      updatedProvider.transformer[model].use = newUseArray;
      
      // If use array is now empty and no other properties, remove model transformer entirely
      if (newUseArray.length === 0 && Object.keys(updatedProvider.transformer[model]).length === 1) {
        delete updatedProvider.transformer[model];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const addProviderTransformerParameter = (_providerIndex: number, transformerIndex: number, paramName: string, paramValue: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    // Add parameter to the specified transformer in use array
    if (updatedProvider.transformer.use && updatedProvider.transformer.use.length > transformerIndex) {
      const targetTransformer = updatedProvider.transformer.use[transformerIndex];
      
      // If it's already an array with parameters, update it
      if (Array.isArray(targetTransformer)) {
        const transformerArray = [...targetTransformer];
        // Check if the second element is an object (parameters object)
        if (transformerArray.length > 1 && typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
          // Update the existing parameters object
          const existingParams = transformerArray[1] as Record<string, unknown>;
          const paramsObj: Record<string, unknown> = { ...existingParams, [paramName]: paramValue };
          transformerArray[1] = paramsObj;
        } else if (transformerArray.length > 1) {
          // If there are other elements, add the parameters object
          const paramsObj = { [paramName]: paramValue };
          transformerArray.splice(1, transformerArray.length - 1, paramsObj);
        } else {
          // Add a new parameters object
          const paramsObj = { [paramName]: paramValue };
          transformerArray.push(paramsObj);
        }
        
        updatedProvider.transformer.use[transformerIndex] = transformerArray as string | (string | Record<string, unknown> | { max_tokens: number })[];
      } else {
        // Convert to array format with parameters
        const paramsObj = { [paramName]: paramValue };
        updatedProvider.transformer.use[transformerIndex] = [targetTransformer as string, paramsObj];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const removeProviderTransformerParameterAtIndex = (_providerIndex: number, transformerIndex: number, paramName: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer?.use || updatedProvider.transformer.use.length <= transformerIndex) {
      return;
    }
    
    const targetTransformer = updatedProvider.transformer.use[transformerIndex];
    if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
      const transformerArray = [...targetTransformer];
      // Check if the second element is an object (parameters object)
      if (typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
        const paramsObj = { ...(transformerArray[1] as Record<string, unknown>) };
        delete paramsObj[paramName];
        
        // If the parameters object is now empty, remove it
        if (Object.keys(paramsObj).length === 0) {
          transformerArray.splice(1, 1);
        } else {
          transformerArray[1] = paramsObj;
        }
        
        updatedProvider.transformer.use[transformerIndex] = transformerArray;
        setEditingProviderData(updatedProvider);
      }
    }
  };

  const addModelTransformerParameter = (_providerIndex: number, model: string, transformerIndex: number, paramName: string, paramValue: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer) {
      updatedProvider.transformer = { use: [] };
    }
    
    if (!updatedProvider.transformer[model]) {
      updatedProvider.transformer[model] = { use: [] };
    }
    
    // Add parameter to the specified transformer in use array
    if (updatedProvider.transformer[model].use && updatedProvider.transformer[model].use.length > transformerIndex) {
      const targetTransformer = updatedProvider.transformer[model].use[transformerIndex];
      
      // If it's already an array with parameters, update it
      if (Array.isArray(targetTransformer)) {
        const transformerArray = [...targetTransformer];
        // Check if the second element is an object (parameters object)
        if (transformerArray.length > 1 && typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
          // Update the existing parameters object
          const existingParams = transformerArray[1] as Record<string, unknown>;
          const paramsObj: Record<string, unknown> = { ...existingParams, [paramName]: paramValue };
          transformerArray[1] = paramsObj;
        } else if (transformerArray.length > 1) {
          // If there are other elements, add the parameters object
          const paramsObj = { [paramName]: paramValue };
          transformerArray.splice(1, transformerArray.length - 1, paramsObj);
        } else {
          // Add a new parameters object
          const paramsObj = { [paramName]: paramValue };
          transformerArray.push(paramsObj);
        }
        
        updatedProvider.transformer[model].use[transformerIndex] = transformerArray as string | (string | Record<string, unknown> | { max_tokens: number })[];
      } else {
        // Convert to array format with parameters
        const paramsObj = { [paramName]: paramValue };
        updatedProvider.transformer[model].use[transformerIndex] = [targetTransformer as string, paramsObj];
      }
    }
    
    setEditingProviderData(updatedProvider);
  };


  const removeModelTransformerParameterAtIndex = (_providerIndex: number, model: string, transformerIndex: number, paramName: string) => {
    if (!editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    if (!updatedProvider.transformer?.[model]?.use || updatedProvider.transformer[model].use.length <= transformerIndex) {
      return;
    }
    
    const targetTransformer = updatedProvider.transformer[model].use[transformerIndex];
    if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
      const transformerArray = [...targetTransformer];
      // Check if the second element is an object (parameters object)
      if (typeof transformerArray[1] === 'object' && transformerArray[1] !== null) {
        const paramsObj = { ...(transformerArray[1] as Record<string, unknown>) };
        delete paramsObj[paramName];
        
        // If the parameters object is now empty, remove it
        if (Object.keys(paramsObj).length === 0) {
          transformerArray.splice(1, 1);
        } else {
          transformerArray[1] = paramsObj;
        }
        
        updatedProvider.transformer[model].use[transformerIndex] = transformerArray;
        setEditingProviderData(updatedProvider);
      }
    }
  };

  const handleAddModel = (_index: number, model: string) => {
    if (!model.trim()) return;

    const trimmed = model.trim();

    // Use functional update to ensure we always work with the latest state
    setEditingProviderData(prev => {
      if (!prev) return prev;

      const models = Array.isArray(prev.models) ? [...prev.models] : [];

      // Check if model already exists
      if (models.includes(trimmed)) {
        showToast(`Model "${trimmed}" already exists`, "warning");
        return prev; // Return same reference = no re-render
      }

      models.push(trimmed);
      showToast(`Added model: ${trimmed}`, "success", 2000);

      // Scroll model badges into view after next render
      setTimeout(() => {
        const el = document.querySelector('[data-model-badges]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);

      return { ...prev, models };
    });
  };

    const handleTemplateImport = (value: string) => {
    if (!value) return;
    try {
      const selectedTemplate = JSON.parse(value);
      if (selectedTemplate) {
        const currentName = editingProviderData?.name;
        const newProviderData = JSON.parse(JSON.stringify(selectedTemplate));

        if (!isNewProvider && currentName) {
          newProviderData.name = currentName;
        }
        
        setEditingProviderData(newProviderData as ProviderType);
      }
    } catch (e) {
      console.error("Failed to parse template", e);
    }
  };

  const handleRemoveModel = (_providerIndex: number, modelIndex: number) => {
    setEditingProviderData(prev => {
      if (!prev) return prev;

      const models = Array.isArray(prev.models) ? [...prev.models] : [];

      if (modelIndex >= 0 && modelIndex < models.length) {
        models.splice(modelIndex, 1);
        return { ...prev, models };
      }
      return prev;
    });
  };

  const handleKeyAddModel = (keyIndex: number, model: string) => {
    if (!model.trim()) return;

    setEditingProviderData(prev => {
      if (!prev) return prev;

      const rawKeys = Array.isArray(prev.api_key) ? [...prev.api_key] : [prev.api_key];
      const entry = rawKeys[keyIndex];

      // Convert to ApiKeyEntry if string, or get existing models
      const keyStr = typeof entry === 'string' ? entry : entry.key;
      const currentModels = typeof entry === 'string' ? null : (entry.models || []);

      // If no explicit models yet, start with all provider models (excluding the one to add if it's already there)
      // Then add the new model
      let newModels: string[];
      if (currentModels === null) {
        // First time adding explicit model - start with provider models
        newModels = [...(prev.models || [])];
      } else {
        // Already has explicit models - use them
        newModels = [...currentModels];
      }

      // Add if not exists
      if (!newModels.includes(model.trim())) {
        newModels.push(model.trim());
        showToast(`Added model to key #${keyIndex + 1}: ${model.trim()}`, "success", 2000);
      }

      rawKeys[keyIndex] = { key: keyStr, models: newModels };
      return { ...prev, api_key: rawKeys };
    });
  };

  const handleKeyRemoveModel = (keyIndex: number, modelIndex: number) => {
    setEditingProviderData(prev => {
      if (!prev) return prev;

      const rawKeys = Array.isArray(prev.api_key) ? [...prev.api_key] : [prev.api_key];
      const entry = rawKeys[keyIndex];

      if (typeof entry === 'string') return prev; // Should not happen if UI logic is correct

      const currentModels = [...(entry.models || [])];

      if (modelIndex >= 0 && modelIndex < currentModels.length) {
        currentModels.splice(modelIndex, 1);
        rawKeys[keyIndex] = { ...entry, models: currentModels };
        return { ...prev, api_key: rawKeys };
      }
      return prev;
    });
  };

  // Helper: compute union of all models from all keys
  const computeAllKeyModelsUnion = (apiKey: ApiKeyConfig): string[] => {
    if (!Array.isArray(apiKey)) {
      return [];
    }

    const union = new Set<string>();
    apiKey.forEach((entry) => {
      if (typeof entry !== 'string' && entry.models) {
        entry.models.forEach((m: string) => union.add(m));
      }
    });
    return Array.from(union);
  };

  // Remove a model from the provider (removes from ALL keys)
  const handleProviderModelRemove = (modelIndex: number) => {
    setEditingProviderData(prev => {
      if (!prev) return prev;

      const allKeyModels = computeAllKeyModelsUnion(prev.api_key);
      const modelToRemove = allKeyModels[modelIndex];

      if (!modelToRemove) return prev;

      // Remove this model from all keys
      const rawKeys = Array.isArray(prev.api_key) ? [...prev.api_key] : [prev.api_key];

      rawKeys.forEach((entry, idx) => {
        if (typeof entry !== 'string' && entry.models) {
          const filtered = entry.models.filter(m => m !== modelToRemove);
          rawKeys[idx] = { ...entry, models: filtered };
        }
      });

      return { ...prev, api_key: rawKeys };
    });
  };

  // Fetch models from provider's /v1/models endpoint
  // Uses server-side proxy to avoid CORS issues
  // First detects if provider is NewAPI (via /api/pricing), then handles accordingly
  const handleFetchModels = async () => {
    if (!editingProviderData) return;

    const { api_base_url, api_key } = editingProviderData;

    // Validate required fields
    if (!api_base_url || !api_key) {
      showToast("Please fill in API Base URL and API Key first", "error");
      return;
    }

    setIsFetchingModels(true);
    setModelFetchError(null);
    setFetchedModels([]);
    setSelectedModels(new Set());

    try {
      // Get API key string (handle array, string, or object)
      let apiKeyStr = '';
      if (typeof api_key === 'string') {
        apiKeyStr = api_key;
      } else if (Array.isArray(api_key) && api_key.length > 0) {
        const firstKey = api_key[0];
        apiKeyStr = typeof firstKey === 'string' ? firstKey : (firstKey?.key || '');
      }

      // Use server-side proxy to avoid CORS
      const result = await api.fetchModels(api_base_url, apiKeyStr);

      if (!result.success) {
        throw new Error(result.error || "Failed to fetch models");
      }

      // Handle NewAPI detection result
      if (result.type === 'newapi' && result.data) {
        setNewApiPricingData(result.data);
        setShowNewApiAssignment(true);
        setIsFetchingModels(false);
        return;
      }

      // Handle standard /v1/models result
      if (result.type === 'models' && result.data) {
        const data = result.data;

        // Parse response - handle standard OpenAI format
        if (data.object === 'list' && Array.isArray(data.data)) {
          const models: ModelData[] = data.data;
          setFetchedModels(models);

          if (editingProviderIndex !== null) {
            setHasFetchedModels(prev => ({
              ...prev,
              [editingProviderIndex]: true
            }));
          }

          const existingModels = editingProviderData.models || [];
          const preSelected = new Set<string>();
          models.forEach(m => {
            if (existingModels.includes(m.id)) {
              preSelected.add(m.id);
            }
          });
          setSelectedModels(preSelected);

          setTargetKeyIndex(0); // Initialize to first key
          setShowModelSelectDialog(true);
        } else {
          throw new Error("Invalid response format from /v1/models");
        }
      }
    } catch (error: any) {
      const errorMsg = error.message || "Failed to fetch models";
      setModelFetchError(errorMsg);
      showToast(`Failed to fetch models: ${errorMsg}`, "error");
    } finally {
      setIsFetchingModels(false);
    }
  };

  // Handle NewAPI assignment confirmation
  const handleNewApiAssignmentConfirm = async (result: { updatedKeys: (string | ApiKeyEntry)[]; allModels: string[] }) => {
    console.log("[Providers] NewAPI assignment confirm:", {
      allModels: result.allModels,
      updatedKeys: result.updatedKeys,
      allModelsCount: result.allModels.length,
    });

    // Directly save to config — cannot rely on editingProviderData
    // because closing the inner Dialog triggers the outer Dialog's onOpenChange,
    // which calls handleCancelAddProvider and resets editingProviderData to null.
    if (editingProviderIndex !== null && editingProviderData) {
      const updatedProvider = { ...editingProviderData, api_key: result.updatedKeys };

      console.log("[Providers] Direct save:", {
        newKeys: result.updatedKeys.length,
        discoveredModels: result.allModels.length,
      });

      const newProviders = [...config.Providers];
      if (isNewProvider) {
        newProviders.push(updatedProvider);
      } else {
        newProviders[editingProviderIndex] = updatedProvider;
      }
      const newConfig = { ...config, Providers: newProviders };
      setConfig(newConfig);
      await flushSave(newConfig);

      showToast(t("newapi_assignment.save_success", { count: result.allModels.length }), "success");
    }

    // Close assignment dialog
    setShowNewApiAssignment(false);
    setNewApiPricingData(null);

    // Close edit dialog (it would close anyway due to Radix nested dialog behavior)
    setEditingProviderIndex(null);
    setEditingProviderData(null);
    setIsNewProvider(false);
  };

  // Handle model selection
  const handleModelToggle = (modelId: string) => {
    setSelectedModels(prev => {
      const newSet = new Set(prev);
      if (newSet.has(modelId)) {
        newSet.delete(modelId);
      } else {
        newSet.add(modelId);
      }
      return newSet;
    });
  };

  // Handle select all models
  const handleSelectAll = () => {
    if (selectedModels.size === fetchedModels.length) {
      // Deselect all
      setSelectedModels(new Set());
    } else {
      // Select all
      setSelectedModels(new Set(fetchedModels.map(m => m.id)));
    }
  };

  // Confirm model selection and add to provider
  const handleConfirmModelSelection = () => {
    if (selectedModels.size === 0) return;

    setEditingProviderData(prev => {
      if (!prev) return prev;

      const rawKeys = Array.isArray(prev.api_key) ? [...prev.api_key] : [prev.api_key];
      const modelsToAdd = Array.from(selectedModels);

      // Get the target key
      const targetKey = rawKeys[targetKeyIndex];

      if (typeof targetKey === 'string') {
        // Convert string to ApiKeyEntry with models
        rawKeys[targetKeyIndex] = { key: targetKey, models: modelsToAdd };
      } else if (targetKey && typeof targetKey === 'object') {
        // Add models to existing entry
        const existingModels = targetKey.models || [];
        const newModels = modelsToAdd.filter(m => !existingModels.includes(m));
        rawKeys[targetKeyIndex] = { ...targetKey, models: [...existingModels, ...newModels] };
      }

      return { ...prev, api_key: rawKeys };
    });

    const actualModelsAdded = selectedModels.size;
    setShowModelSelectDialog(false);
    setFetchedModels([]);
    setSelectedModels(new Set());
    showToast(`Added ${actualModelsAdded} model(s) to Key #${targetKeyIndex + 1}`, "success");
  };

  // Cancel model selection
  const handleCancelModelSelection = () => {
    setShowModelSelectDialog(false);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setModelFetchError(null);
    setModelSearchTerm("");
    setTargetKeyIndex(0); // Reset to first key
  };

  // Filter models based on search term
  const filteredModels = fetchedModels.filter(model => {
    if (!modelSearchTerm) return true;
    const term = modelSearchTerm.toLowerCase();
    return model.id.toLowerCase().includes(term) ||
           (model.owned_by && model.owned_by.toLowerCase().includes(term));
  });

  const editingProvider = editingProviderData || (editingProviderIndex !== null ? validProviders[editingProviderIndex] : null);

  // Batch test handlers
  const handleRunBatchTests = async (selectedTests: BatchTestResult[]) => {
    if (selectedTests.length === 0) return;

    const tests = selectedTests.map(t => ({
      provider: t.provider,
      model: t.model,
      ...(t.keyIndex !== undefined ? { keyIndex: t.keyIndex } : {}),
    }));

    setBatchTestResults(prev => markBatchTestsAsTesting(prev, selectedTests));

    try {
      const result = await api.startBatchTest(tests, batchTestConcurrency);
      if (result.success) {
        setIsBatchTesting(true);
        showToast(
          t("batch_test.started", { total: result.total, concurrency: result.concurrency }),
          'success',
          3000
        );
        // Immediately poll once to get initial state
        await pollBatchTestStatus();
        startPolling();
      } else {
        showToast(result.error || t("batch_test.start_failed"), 'error', 5000);
      }
    } catch (err: any) {
      // Handle 409 Conflict (task already running)
      if (err.status === 409) {
        showToast(t("batch_test.already_running"), 'warning', 5000);
      } else {
        showToast(err.message || t("batch_test.start_failed"), 'error', 5000);
      }
      await pollBatchTestStatus();
    }
  };

  const handleRetrySingleBatchTest = async (test: BatchTestResult) => {
    await handleRunBatchTests([test]);
  };

  const handleCancelBatchTest = async () => {
    try {
      const result = await api.cancelBatchTest();
      if (result.success) {
        showToast(
          t("batch_test.cancelled", { completed: result.completed, cancelled: result.cancelled }),
          'warning',
          5000
        );
        // Poll one more time to get final state
        await pollBatchTestStatus();
      }
    } catch (err: any) {
      showToast(err.message || t("batch_test.cancel_failed"), 'error', 5000);
    }
  };

  const handleBatchTestAll = async () => {
    // Collect all tests, expanding per-key when keys have model filters
    const allTests: Array<{ provider: string; model: string; keyIndex?: number }> = [];
    for (const provider of validProviders) {
      if (!provider.name || !provider.models) continue;

      const rawKeys = Array.isArray(provider.api_key) ? provider.api_key : [provider.api_key];
      const hasPerKeyModels = rawKeys.some(
        k => typeof k !== 'string' && k?.models && k.models.length > 0
      );

      if (hasPerKeyModels && rawKeys.length > 1) {
        // Per-key testing: each key tests only its own models
        rawKeys.forEach((entry, keyIdx) => {
          const keyModels = typeof entry !== 'string' && entry?.models && entry.models.length > 0
            ? entry.models
            : provider.models!; // Keys without filter test all models
          for (const model of keyModels) {
            if (provider.models!.includes(model)) {
              allTests.push({ provider: provider.name, model, keyIndex: keyIdx });
            }
          }
        });
      } else {
        // Standard: all models, no specific key
        for (const model of provider.models) {
          allTests.push({ provider: provider.name, model });
        }
      }
    }

    if (allTests.length === 0) {
      showToast(t("batch_test.no_models_to_test"), "warning");
      return;
    }

    // Try to load persisted results first
    try {
      const data = await api.getBatchTestResults();
      if (data?.results?.length > 0) {
        const mergedResults = mergePersistedBatchTests(allTests, data.results);
        setBatchTestResults(mergedResults);
        if (data.startedAt) setBatchTestStartedAt(data.startedAt);
        if (data.completedAt) setBatchTestCompletedAt(data.completedAt);
      } else {
        const freshResults = buildFreshBatchTests(allTests);
        setBatchTestResults(freshResults);
        setBatchTestStartedAt(null);
        setBatchTestCompletedAt(null);
      }
    } catch {
      // Failed to load persisted results, create fresh idle results
      const freshResults = buildFreshBatchTests(allTests);
      setBatchTestResults(freshResults);
      setBatchTestStartedAt(null);
      setBatchTestCompletedAt(null);
    }

    setShowBatchTestDialog(true);
    // Don't auto-start, let user select and run
  };

  // Filter providers based on search term
  const filteredProviders = validProviders.filter(provider => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    // Check provider name and URL
    if (
      (provider.name && provider.name.toLowerCase().includes(term)) ||
      (provider.api_base_url && provider.api_base_url.toLowerCase().includes(term))
    ) {
      return true;
    }
    // Check models
    if (provider.models && Array.isArray(provider.models)) {
      return provider.models.some(model =>
        model && model.toLowerCase().includes(term)
      );
    }
    return false;
  });

  // Sort providers by total success count (descending)
  const sortedProviders = [...filteredProviders].sort((a, b) => {
    const aTotal = (a.models || []).reduce((sum, model) => {
      const stats = requestStats?.find(s => s.provider === a.name && s.model === model);
      return sum + (stats?.success || 0);
    }, 0);

    const bTotal = (b.models || []).reduce((sum, model) => {
      const stats = requestStats?.find(s => s.provider === b.name && s.model === model);
      return sum + (stats?.success || 0);
    }, 0);

    return bTotal - aTotal; // Descending order
  });

  return (
    <Card className="flex h-full flex-col rounded-lg border shadow-sm">
      <CardHeader className="flex flex-col border-b p-4 gap-3">
        <div className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">{t("providers.title")} <span className="text-sm font-normal text-gray-500">({filteredProviders.length}/{validProviders.length})</span></CardTitle>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleBatchTestAll}
            >
              <Play className="h-4 w-4" />
              {t("providers.test")}
            </Button>
            <Button onClick={handleAddProvider}>{t("providers.add")}</Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <Input
              placeholder={t("providers.search")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-8"
            />
          </div>
          {searchTerm && (
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setSearchTerm("")}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-grow overflow-y-auto p-4">
        <ProviderList
          providers={sortedProviders}
          onEdit={handleEditProvider}
          onRemove={handleSetDeletingProviderIndex}
          showToast={showToast}
          removeToast={removeToast}
          requestStats={requestStats}
          testPrompt={config?.TEST_PROMPT}
          hoveredModel={hoveredModel}
          onBadgeRef={onBadgeRef}
          searchTerm={searchTerm}
        />
      </CardContent>

      {/* Edit Dialog */}
      <Dialog open={editingProviderIndex !== null && !showNewApiAssignment} onOpenChange={(open) => {
        if (!open) {
          handleCancelAddProvider();
        }
      }}>
        <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("providers.edit")}</DialogTitle>
          </DialogHeader>
          {editingProvider && editingProviderIndex !== null && (
            <div className="space-y-4 p-4 overflow-y-auto flex-grow">
              {providerTemplates.length > 0 && (
                <div className="space-y-2">
                  <Label>{t("providers.import_from_template")}</Label>
                  <Combobox
                    options={providerTemplates.map(p => ({ label: p.name, value: JSON.stringify(p) }))}
                    value=""
                    onChange={handleTemplateImport}
                    placeholder={t("providers.select_template")}
                    emptyPlaceholder={t("providers.no_templates_found")}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="name">{t("providers.name")}</Label>
                <Input 
                  id="name" 
                  value={editingProvider.name || ''} 
                  onChange={(e) => {
                    handleProviderChange(editingProviderIndex, 'name', e.target.value);
                    // Clear name error when user starts typing
                    if (nameError) {
                      setNameError(null);
                    }
                  }}
                  className={nameError ? "border-red-500" : ""}
                />
                {nameError && (
                  <p className="text-sm text-red-500">{nameError}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="api_base_url">{t("providers.api_base_url")}</Label>
                <Input id="api_base_url" value={editingProvider.api_base_url || ''} onChange={(e) => handleProviderChange(editingProviderIndex, 'api_base_url', e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api_key">{t("providers.api_key")}</Label>
                <div className="space-y-2">
                  {(() => {
                    // Normalize api_key to array of entries
                    const rawKeys = Array.isArray(editingProvider.api_key)
                      ? editingProvider.api_key
                      : [editingProvider.api_key || ''];

                    // Helper to extract key string from string or ApiKeyEntry
                    const getKeyString = (entry: string | ApiKeyEntry): string =>
                      typeof entry === 'string' ? entry : (entry?.key || '');

                    // Helper to get models assigned to a key (null = supports all provider models)
                    const getKeyModels = (entry: string | ApiKeyEntry): string[] | null =>
                      typeof entry === 'string' ? null : (entry?.models && entry.models.length > 0 ? entry.models : null);

                    return rawKeys.map((entry, keyIndex) => (
                      <div key={keyIndex} className="space-y-1">
                        <div className="relative">
                          <Input
                            id={`api_key_${keyIndex}`}
                            type={showApiKey[`${editingProviderIndex}_${keyIndex}`] ? "text" : "password"}
                            value={getKeyString(entry)}
                            onChange={(e) => {
                              const newKeys = [...rawKeys];
                              const currentModels = getKeyModels(entry);
                              // Preserve explicit key models if set
                              if (currentModels) {
                                newKeys[keyIndex] = { key: e.target.value, models: currentModels };
                              } else {
                                newKeys[keyIndex] = e.target.value;
                              }
                              if (newKeys.length === 1 && !Array.isArray(editingProvider.api_key) && typeof newKeys[0] === 'string') {
                                handleProviderChange(editingProviderIndex, 'api_key', e.target.value);
                              } else {
                                handleProviderChange(editingProviderIndex, 'api_key', newKeys);
                              }
                            }}
                            className={apiKeyError ? "border-red-500" : ""}
                          />
                          <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => {
                                const index = `${editingProviderIndex}_${keyIndex}`;
                                setShowApiKey(prev => ({
                                  ...prev,
                                  [index]: !prev[index]
                                }));
                              }}
                            >
                              {showApiKey[`${editingProviderIndex}_${keyIndex}`] ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                            {rawKeys.length > 1 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => {
                                  const newKeys = rawKeys.filter((_, i) => i !== keyIndex);
                                  if (newKeys.length === 1 && typeof newKeys[0] === 'string') {
                                    handleProviderChange(editingProviderIndex, 'api_key', newKeys[0]);
                                  } else {
                                    handleProviderChange(editingProviderIndex, 'api_key', newKeys);
                                  }
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                        {/* Per-key stats summary */}
                        {rawKeys.length > 1 && (() => {
                          const providerName = editingProvider.name || '';
                          const keyStats = requestStats?.filter(
                            (s: any) => s.provider === providerName && s.keyIndex === keyIndex
                          ) || [];
                          const totalSuccess = keyStats.reduce((sum: number, s: any) => sum + (s.success || 0), 0);
                          const totalFail = keyStats.reduce((sum: number, s: any) => sum + (s.fail || 0), 0);
                          if (totalSuccess === 0 && totalFail === 0) return null;
                          return (
                            <div className="pl-2 flex items-center gap-2 text-xs text-muted-foreground">
                              <span className="text-emerald-600 flex items-center gap-0.5">
                                <Check className="h-3 w-3" /> {totalSuccess}
                              </span>
                              <span className="text-rose-600 flex items-center gap-0.5">
                                <X className="h-3 w-3" /> {totalFail}
                              </span>
                            </div>
                          );
                        })()}
                        {/* Per-key model management - only show when there are multiple keys */}
                        {rawKeys.length > 1 && (
                          <div className="pl-2 space-y-2 border-t pt-2 mt-2">
                            <Label className="text-xs text-muted-foreground">
                              Key Models (click + to add, X to remove)
                            </Label>
                            <div className="flex gap-2">
                              <Input
                                placeholder="Add model to this key"
                                value={keyModelInputs[keyIndex] || ""}
                                onChange={(e) => setKeyModelInputs(prev => ({ ...prev, [keyIndex]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && keyModelInputs[keyIndex]?.trim()) {
                                    handleKeyAddModel(keyIndex, keyModelInputs[keyIndex]);
                                    setKeyModelInputs(prev => ({ ...prev, [keyIndex]: "" }));
                                  }
                                }}
                                className="flex-1"
                              />
                              <Button
                                size="sm"
                                disabled={!keyModelInputs[keyIndex]?.trim()}
                                onClick={() => {
                                  if (keyModelInputs[keyIndex]?.trim()) {
                                    handleKeyAddModel(keyIndex, keyModelInputs[keyIndex]);
                                    setKeyModelInputs(prev => ({ ...prev, [keyIndex]: "" }));
                                  }
                                }}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {getKeyModels(entry)?.map((model, modelIdx) => {
                                const status = getRequestStatus(requestStats, editingProvider.name || '', model);
                                return (
                                  <Badge
                                    key={model}
                                    variant="outline"
                                    className={`font-normal flex items-center gap-1 text-xs ${getStatusBadgeClasses(status)}`}
                                  >
                                    {model}
                                    <button
                                      type="button"
                                      className="ml-1 rounded-full hover:bg-gray-200"
                                      onClick={() => handleKeyRemoveModel(keyIndex, modelIdx)}
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    ));
                  })()}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      const rawKeys = Array.isArray(editingProvider.api_key)
                        ? [...editingProvider.api_key, '']
                        : [editingProvider.api_key || '', ''];
                      handleProviderChange(editingProviderIndex, 'api_key', rawKeys);
                    }}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    {t("providers.add_api_key")}
                  </Button>
                </div>
                {apiKeyError && (
                  <p className="text-sm text-red-500">{apiKeyError}</p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("providers.models")} (computed from all keys)</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleFetchModels}
                    disabled={isFetchingModels}
                  >
                    {isFetchingModels ? "..." : t('model_selector.fetch_from_endpoint')}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 pt-2" data-model-badges>
                  {computeAllKeyModelsUnion(editingProvider.api_key).map((model: string, modelIndex: number) => {
                    const status = getRequestStatus(requestStats, editingProvider.name || '', model);
                    return (
                      <Badge key={modelIndex} variant="outline" className={`font-normal flex items-center gap-1 ${getStatusBadgeClasses(status)}`}>
                        {model}
                        <button
                          type="button"
                          className="ml-1 rounded-full hover:bg-gray-200"
                          onClick={() => editingProviderIndex !== null && handleProviderModelRemove(modelIndex)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
                {/* Remove error models button — only shown when error models exist */}
                {(() => {
                  const allKeyModels = computeAllKeyModelsUnion(editingProvider.api_key);
                  const errorModels = allKeyModels.filter(
                    (model: string) => getRequestStatus(requestStats, editingProvider.name || '', model) === 'error'
                  );
                  if (errorModels.length === 0) return null;
                  return (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 text-red-600 border-red-300 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/20"
                      onClick={() => {
                        setEditingProviderData(prev => {
                          if (!prev) return prev;

                          const rawKeys = Array.isArray(prev.api_key) ? [...prev.api_key] : [prev.api_key];

                          // Remove all error models from all keys
                          rawKeys.forEach((entry, idx) => {
                            if (typeof entry !== 'string' && entry.models) {
                              const filtered = entry.models.filter(m => !errorModels.includes(m));
                              rawKeys[idx] = { ...entry, models: filtered };
                            }
                          });

                          return { ...prev, api_key: rawKeys };
                        });
                        showToast(t("providers.removed_error_models", { count: errorModels.length }), "success");
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {t("providers.remove_error_models", { count: errorModels.length })}
                    </Button>
                  );
                })()}
              </div>

              {/* Provider Transformer Selection */}
              <div className="space-y-2">
                <Label>{t("providers.provider_transformer")}</Label>

                {/* Add new transformer */}
                <div className="flex gap-2">
                  <Combobox
                    options={availableTransformers.map(t => ({
                      label: t.name,
                      value: t.name
                    }))}
                    value=""
                    onChange={(value) => {
                      if (editingProviderIndex !== null) {
                        handleProviderTransformerChange(editingProviderIndex, value);
                      }
                    }}
                    placeholder={t("providers.select_transformer")}
                    emptyPlaceholder={t("providers.no_transformers")}
                    modal={true}
                  />
                </div>

                {/* Display existing transformers */}
                {editingProvider.transformer?.use && editingProvider.transformer.use.length > 0 && (
                  <div className="space-y-1.5 mt-2">
                    <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                    {editingProvider.transformer.use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => (
                      <div key={transformerIndex} className="border rounded-md p-2">
                        <div className="flex gap-2 items-center mb-1.5">
                          <div className="flex-1 bg-gray-50 rounded px-2 py-1.5 text-sm leading-tight">
                            {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                          </div>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => {
                              if (editingProviderIndex !== null) {
                                removeProviderTransformerAtIndex(editingProviderIndex, transformerIndex);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>

                        {/* Transformer-specific Parameters */}
                        <div className="mt-1.5 pl-3 border-l-2 border-gray-200">
                          <Label className="text-xs text-gray-600">{t("providers.transformer_parameters")}</Label>
                          <div className="space-y-1.5 mt-1">
                            <div className="flex gap-2">
                              <Input
                                placeholder={t("providers.parameter_name")}
                                className="h-8"
                                value={providerParamInputs[`provider-${editingProviderIndex}-transformer-${transformerIndex}`]?.name || ""}
                                onChange={(e) => {
                                  const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                  setProviderParamInputs(prev => ({
                                    ...prev,
                                    [key]: {
                                      ...prev[key] || {name: "", value: ""},
                                      name: e.target.value
                                    }
                                  }));
                                }}
                              />
                              <Input
                                placeholder={t("providers.parameter_value")}
                                className="h-8"
                                value={providerParamInputs[`provider-${editingProviderIndex}-transformer-${transformerIndex}`]?.value || ""}
                                onChange={(e) => {
                                  const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                  setProviderParamInputs(prev => ({
                                    ...prev,
                                    [key]: {
                                      ...prev[key] || {name: "", value: ""},
                                      value: e.target.value
                                    }
                                  }));
                                }}
                              />
                              <Button
                                size="sm"
                                className="h-8 px-2"
                                onClick={() => {
                                  if (editingProviderIndex !== null) {
                                    const key = `provider-${editingProviderIndex}-transformer-${transformerIndex}`;
                                    const paramInput = providerParamInputs[key];
                                    if (paramInput && paramInput.name && paramInput.value) {
                                      addProviderTransformerParameter(editingProviderIndex, transformerIndex, paramInput.name, paramInput.value);
                                      setProviderParamInputs(prev => ({
                                        ...prev,
                                        [key]: {name: "", value: ""}
                                      }));
                                    }
                                  }
                                }}
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </div>

                            {/* Display existing parameters for this transformer */}
                            {(() => {
                              // Get parameters for this specific transformer
                              if (!editingProvider.transformer?.use || editingProvider.transformer.use.length <= transformerIndex) {
                                return null;
                              }
                              
                              const targetTransformer = editingProvider.transformer.use[transformerIndex];
                              let params = {};
                              
                              if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
                                // Check if the second element is an object (parameters object)
                                if (typeof targetTransformer[1] === 'object' && targetTransformer[1] !== null) {
                                  params = targetTransformer[1] as Record<string, unknown>;
                                }
                              }
                              
                              return Object.keys(params).length > 0 ? (
                                <div className="space-y-1">
                                  {Object.entries(params).map(([key, value]) => (
                                    <div key={key} className="flex items-center justify-between bg-gray-50 rounded p-2">
                                      <div className="text-sm">
                                        <span className="font-medium">{key}:</span> {String(value)}
                                      </div>
                                      <Button 
                                        variant="ghost" 
                                        size="sm"
                                        className="h-6 w-6 p-0"
                                        onClick={() => {
                                          if (editingProviderIndex !== null) {
                                            // We need a function to remove parameters from a specific transformer
                                            removeProviderTransformerParameterAtIndex(editingProviderIndex, transformerIndex, key);
                                          }
                                        }}
                                      >
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              
              {/* Model-specific Transformers */}
              {editingProvider.models && editingProvider.models.length > 0 && (
                <div className="space-y-2">
                  <Label>{t("providers.model_transformers")}</Label>
                  <div className="space-y-2">
                    {(editingProvider.models || []).map((model: string, modelIndex: number) => (
                      <div key={modelIndex} className="border rounded-md p-2">
                        <div className="font-medium text-sm mb-1.5">{model}</div>
                        {/* Add new transformer */}
                        <div className="flex gap-2">
                          <div className="flex-1 flex gap-2">
                            <Combobox
                              options={availableTransformers.map(t => ({
                                label: t.name,
                                value: t.name
                              }))}
                              value=""
                              onChange={(value) => {
                                if (editingProviderIndex !== null) {
                                  handleModelTransformerChange(editingProviderIndex, model, value);
                                }
                              }}
                              placeholder={t("providers.select_transformer")}
                              emptyPlaceholder={t("providers.no_transformers")}
                              modal={true}
                            />
                          </div>
                        </div>

                        {/* Display existing transformers */}
                        {editingProvider.transformer?.[model]?.use && editingProvider.transformer[model].use.length > 0 && (
                          <div className="space-y-1.5 mt-2">
                            <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                            {editingProvider.transformer[model].use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => (
                              <div key={transformerIndex} className="border rounded-md p-2">
                                <div className="flex gap-2 items-center mb-1.5">
                                  <div className="flex-1 bg-gray-50 rounded px-2 py-1.5 text-sm leading-tight">
                                    {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() => {
                                      if (editingProviderIndex !== null) {
                                        removeModelTransformerAtIndex(editingProviderIndex, model, transformerIndex);
                                      }
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </Button>
                                </div>

                                {/* Transformer-specific Parameters */}
                                <div className="mt-1.5 pl-3 border-l-2 border-gray-200">
                                  <Label className="text-xs text-gray-600">{t("providers.transformer_parameters")}</Label>
                                  <div className="space-y-1.5 mt-1">
                                    <div className="flex gap-2">
                                      <Input
                                        placeholder={t("providers.parameter_name")}
                                        className="h-8"
                                        value={modelParamInputs[`model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`]?.name || ""}
                                        onChange={(e) => {
                                          const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                          setModelParamInputs(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...prev[key] || {name: "", value: ""},
                                              name: e.target.value
                                            }
                                          }));
                                        }}
                                      />
                                      <Input
                                        placeholder={t("providers.parameter_value")}
                                        className="h-8"
                                        value={modelParamInputs[`model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`]?.value || ""}
                                        onChange={(e) => {
                                          const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                          setModelParamInputs(prev => ({
                                            ...prev,
                                            [key]: {
                                              ...prev[key] || {name: "", value: ""},
                                              value: e.target.value
                                            }
                                          }));
                                        }}
                                      />
                                      <Button
                                        size="sm"
                                        className="h-8 px-2"
                                        onClick={() => {
                                          if (editingProviderIndex !== null) {
                                            const key = `model-${editingProviderIndex}-${model}-transformer-${transformerIndex}`;
                                            const paramInput = modelParamInputs[key];
                                            if (paramInput && paramInput.name && paramInput.value) {
                                              addModelTransformerParameter(editingProviderIndex, model, transformerIndex, paramInput.name, paramInput.value);
                                              setModelParamInputs(prev => ({
                                                ...prev,
                                                [key]: {name: "", value: ""}
                                              }));
                                            }
                                          }
                                        }}
                                      >
                                        <Plus className="h-4 w-4" />
                                      </Button>
                                    </div>

                                    {/* Display existing parameters for this transformer */}
                                    {(() => {
                                      // Get parameters for this specific transformer
                                      if (!editingProvider.transformer?.[model]?.use || editingProvider.transformer[model].use.length <= transformerIndex) {
                                        return null;
                                      }

                                      const targetTransformer = editingProvider.transformer[model].use[transformerIndex];
                                      let params = {};

                                      if (Array.isArray(targetTransformer) && targetTransformer.length > 1) {
                                        // Check if the second element is an object (parameters object)
                                        if (typeof targetTransformer[1] === 'object' && targetTransformer[1] !== null) {
                                          params = targetTransformer[1] as Record<string, unknown>;
                                        }
                                      }

                                      return Object.keys(params).length > 0 ? (
                                        <div className="space-y-1">
                                          {Object.entries(params).map(([key, value]) => (
                                            <div key={key} className="flex items-center justify-between bg-gray-50 rounded p-2">
                                              <div className="text-sm">
                                                <span className="font-medium">{key}:</span> {String(value)}
                                              </div>
                                              <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-6 w-6 p-0"
                                                onClick={() => {
                                                  if (editingProviderIndex !== null) {
                                                    // We need a function to remove parameters from a specific transformer
                                                    removeModelTransformerParameterAtIndex(editingProviderIndex, model, transformerIndex, key);
                                                  }
                                                }}
                                              >
                                                <X className="h-3 w-3" />
                                              </Button>
                                            </div>
                                          ))}
                                        </div>
                                      ) : null;
                                    })()}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
          <div className="space-y-3 mt-auto">
            <div className="flex justify-end gap-2">
              {/* <Button
                variant="outline"
                onClick={() => editingProvider && testConnectivity(editingProvider)}
                disabled={isTestingConnectivity || !editingProvider}
              >
                <Wifi className="mr-2 h-4 w-4" />
                {isTestingConnectivity ? t("providers.testing") : t("providers.test_connectivity")}
              </Button> */}
              <Button onClick={handleSaveProvider}>{t("app.save")}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deletingProviderIndex !== null} onOpenChange={() => setDeletingProviderIndex(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("providers.delete")}</DialogTitle>
            <DialogDescription>
              {t("providers.delete_provider_confirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingProviderIndex(null)}>{t("providers.cancel")}</Button>
            <Button variant="destructive" onClick={() => deletingProviderIndex !== null && handleRemoveProvider(deletingProviderIndex)}>{t("providers.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* NewAPI Model Assignment Dialog */}
      {editingProviderData && newApiPricingData && (
        <NewApiAssignmentDialog
          open={showNewApiAssignment}
          onOpenChange={(open) => {
            setShowNewApiAssignment(open);
            if (!open) setNewApiPricingData(null);
          }}
          pricingData={newApiPricingData}
          apiKeys={Array.isArray(editingProviderData.api_key) ? editingProviderData.api_key : [editingProviderData.api_key || '']}
          apiBaseUrl={editingProviderData.api_base_url || ''}
          existingModels={editingProviderData.models || []}
          onConfirm={handleNewApiAssignmentConfirm}
          showToast={showToast as any}
        />
      )}

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelectDialog} onOpenChange={handleCancelModelSelection}>
        <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('model_selector.title')}</DialogTitle>
            <DialogDescription>
              {t('model_selector.description')}
            </DialogDescription>
          </DialogHeader>
          {modelFetchError ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-600">{modelFetchError}</p>
            </div>
          ) : (
            <div className="flex-grow overflow-y-auto">
              {/* Target API Key Selector */}
              <div className="mb-4">
                <Label className="mb-2 block">Add to API Key:</Label>
                <div className="flex gap-2">
                  {(() => {
                    const keys = Array.isArray(editingProviderData?.api_key)
                      ? editingProviderData.api_key
                      : [editingProviderData?.api_key || ''];
                    return keys.map((entry, idx) => {
                      const keyStr = typeof entry === 'string' ? entry : (entry?.key || '');
                      const display = keyStr.length <= 10 ? '****' : `${keyStr.substring(0, 4)}...${keyStr.substring(keyStr.length - 2)}`;
                      return (
                        <Button
                          key={idx}
                          variant={targetKeyIndex === idx ? 'default' : 'outline'}
                          onClick={() => setTargetKeyIndex(idx)}
                          className="flex-1"
                        >
                          Key #{idx + 1} ({display})
                        </Button>
                      );
                    });
                  })()}
                </div>
              </div>
              <div className="mb-4 flex items-center gap-2 border-b pb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  <Input
                    placeholder={t('model_selector.search_placeholder')}
                    value={modelSearchTerm}
                    onChange={(e) => setModelSearchTerm(e.target.value)}
                    className="pl-8"
                  />
                </div>
                {modelSearchTerm && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setModelSearchTerm("")}
                  >
                    <XCircle className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <div className="mb-4 flex items-center gap-4 border-b pb-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={selectedModels.size === fetchedModels.length && fetchedModels.length > 0}
                    onCheckedChange={handleSelectAll}
                  />
                  <span className="text-sm">{t('model_selector.select_all')}</span>
                </label>
                <span className="text-sm text-gray-500">
                  {t('model_selector.selected_count', { selected: selectedModels.size, total: filteredModels.length })}
                </span>
              </div>
              <div className="space-y-1">
                {filteredModels.map((model) => (
                  <label
                    key={model.id}
                    className="flex items-center gap-3 p-3 hover:bg-gray-50 rounded-md cursor-pointer border-b last:border-b-0"
                  >
                    <Checkbox
                      checked={selectedModels.has(model.id)}
                      onCheckedChange={() => handleModelToggle(model.id)}
                    />
                    <div className="flex-1">
                      <div className="font-medium">{model.id}</div>
                      {model.owned_by && (
                        <div className="text-xs text-gray-500">{model.owned_by}</div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={handleCancelModelSelection}>
              {t('model_selector.cancel')}
            </Button>
            <Button onClick={handleConfirmModelSelection} disabled={selectedModels.size === 0}>
              {t('model_selector.confirm', { count: selectedModels.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Test Results Dialog */}
      <BatchTestDialog
        open={showBatchTestDialog}
        onClose={() => setShowBatchTestDialog(false)}
        results={batchTestResults}
        title={t("batch_test.title")}
        onRunTests={handleRunBatchTests}
        onRetryTest={handleRetrySingleBatchTest}
        onCancel={handleCancelBatchTest}
        isRunning={isBatchTesting}
        concurrency={batchTestConcurrency}
        onConcurrencyChange={setBatchTestConcurrency}
        startedAt={batchTestStartedAt}
        completedAt={batchTestCompletedAt}
        providerApiUrls={Object.fromEntries(
          validProviders
            .filter(p => p.name && p.api_base_url)
            .map(p => [p.name, p.api_base_url])
        )}
        onTestConnectivity={async (provider: string, url: string) => {
          const toastId = showToast(t("provider_list.connectivity_testing", { url }), 'warning', 0);
          try {
            const result = await api.testConnectivity(url);
            removeToast(toastId);
            if (result?.success) {
              showToast(
                t("provider_list.connectivity_ok", { url, ms: result.latency_ms, status: result.status }),
                'success',
                5000
              );
            } else {
              showToast(
                t("provider_list.connectivity_fail", { url, error: result?.error || 'Unknown error' }),
                'error',
                8000
              );
            }
          } catch (err: any) {
            removeToast(toastId);
            showToast(
              t("provider_list.connectivity_fail", { url, error: err?.message || 'Network error' }),
              'error',
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
    </Card>
  );
}
