import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
import { X, Trash2, Plus, Eye, EyeOff, Search, XCircle, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { ComboInput } from "@/components/ui/combo-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import type { Provider } from "@/types";
import { BatchTestDialog } from "./BatchTestDialog";
import type { BatchTestResult } from "./BatchTestDialog";

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
  removeToast,
  hoveredModel,
  onBadgeRef
}: {
  showToast: (message: string, type: 'success' | 'error' | 'warning', duration?: number) => string;
  removeToast: (id: string) => void;
  hoveredModel?: { provider: string | null; model: string | null } | null | undefined;
  onBadgeRef?: (provider: string, model: string, ref: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation();
  const { config, setConfig } = useConfig();
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

  // Model fetching state
  const [isFetchingModels, setIsFetchingModels] = useState<boolean>(false);
  const [fetchedModels, setFetchedModels] = useState<ModelData[]>([]);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [showModelSelectDialog, setShowModelSelectDialog] = useState<boolean>(false);
  const [modelFetchError, setModelFetchError] = useState<string | null>(null);
  const [modelSearchTerm, setModelSearchTerm] = useState<string>("");

  // Batch test state
  const [showBatchTestDialog, setShowBatchTestDialog] = useState<boolean>(false);
  const [batchTestResults, setBatchTestResults] = useState<BatchTestResult[]>([]);
  const [isBatchTesting, setIsBatchTesting] = useState<boolean>(false);

  // Load results from localStorage on mount
  useEffect(() => {
    try {
      const savedResults = localStorage.getItem('batchTestResults');
      if (savedResults) {
        setBatchTestResults(JSON.parse(savedResults));
      }
    } catch (e) {
      console.error('Failed to load batch test results:', e);
    }
  }, []);

  // Save results to localStorage whenever they change
  useEffect(() => {
    try {
      if (batchTestResults.length > 0) {
        localStorage.setItem('batchTestResults', JSON.stringify(batchTestResults));
      }
    } catch (e) {
      console.error('Failed to save batch test results:', e);
    }
  }, [batchTestResults]);

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
    const actualIndex = validProviders.indexOf(filteredProviders[index]);
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

  const handleSaveProvider = () => {
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
    
    // Validate API key - support single string or array
    const apiKeys = Array.isArray(editingProviderData.api_key)
      ? editingProviderData.api_key
      : [editingProviderData.api_key];

    if (!apiKeys.some(k => k && k.trim() !== '')) {
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
      setConfig({ ...config, Providers: newProviders });
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
    const actualIndex = validProviders.indexOf(filteredProviders[filteredIndex]);
    const newProviders = [...config.Providers];
    newProviders.splice(actualIndex, 1);
    setConfig({ ...config, Providers: newProviders });
    setDeletingProviderIndex(null);
  };

  const handleProviderChange = (_index: number, field: string, value: string | string[]) => {
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
    if (!model.trim() || !editingProviderData) return;
    
    const updatedProvider = { ...editingProviderData };
    
    // Handle case where provider.models might be null or undefined
    const models = Array.isArray(updatedProvider.models) ? [...updatedProvider.models] : [];
    
    // Check if model already exists
    if (!models.includes(model.trim())) {
      models.push(model.trim());
      updatedProvider.models = models;
      setEditingProviderData(updatedProvider);
    }
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
    if (!editingProviderData) return;

    const updatedProvider = { ...editingProviderData };

    // Handle case where provider.models might be null or undefined
    const models = Array.isArray(updatedProvider.models) ? [...updatedProvider.models] : [];

    // Handle case where modelIndex might be out of bounds
    if (modelIndex >= 0 && modelIndex < models.length) {
      models.splice(modelIndex, 1);
      updatedProvider.models = models;
      setEditingProviderData(updatedProvider);
    }
  };

  // Fetch models from provider's /v1/models endpoint
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
      // Extract base URL and construct models endpoint
      // Remove trailing slash
      let baseUrl = api_base_url.replace(/\/$/, '');
      // Remove /v1, /v1/messages, /v1/chat/completions, etc. to get the actual base URL
      baseUrl = baseUrl.replace(/\/v1\/?.*$/, '');
      // Construct models endpoint
      const modelsUrl = `${baseUrl}/v1/models`;

      // Get API key (handle array or string)
      const apiKey = Array.isArray(api_key) ? api_key[0] || '' : api_key;

      // Create timeout signal (5 seconds)
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), 5000);

      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: timeoutController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Try to read error response body
        let errorDetail = response.statusText;
        try {
          const errorBody = await response.text();
          if (errorBody) {
            errorDetail = `${response.status} - ${errorBody}`;
          }
        } catch (e) {
          // If we can't read the body, just use status
        }
        throw new Error(`HTTP ${response.status}: ${errorDetail}`);
      }

      const data = await response.json();

      // Parse response - handle standard OpenAI format
      if (data.object === 'list' && Array.isArray(data.data)) {
        const models: ModelData[] = data.data;
        setFetchedModels(models);

        // Pre-select models that are already in the provider's model list
        const existingModels = editingProviderData.models || [];
        const preSelected = new Set<string>();
        models.forEach(m => {
          if (existingModels.includes(m.id)) {
            preSelected.add(m.id);
          }
        });
        setSelectedModels(preSelected);

        // Open the selection dialog
        setShowModelSelectDialog(true);
      } else {
        throw new Error("Invalid response format from /v1/models");
      }
    } catch (error: any) {
      const errorMsg = error.message || "Failed to fetch models";
      setModelFetchError(errorMsg);
      showToast(`Failed to fetch models: ${errorMsg}`, "error");
    } finally {
      setIsFetchingModels(false);
    }
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
    if (!editingProviderData) return;

    const existingModels = Array.isArray(editingProviderData.models) ? [...editingProviderData.models] : [];
    const newModels = Array.from(selectedModels).filter(id => !existingModels.includes(id));

    if (newModels.length > 0) {
      const updatedProvider = { ...editingProviderData };
      updatedProvider.models = [...existingModels, ...newModels];
      setEditingProviderData(updatedProvider);
      showToast(`Added ${newModels.length} model(s)`, "success");
    }

    setShowModelSelectDialog(false);
    setFetchedModels([]);
    setSelectedModels(new Set());
  };

  // Cancel model selection
  const handleCancelModelSelection = () => {
    setShowModelSelectDialog(false);
    setFetchedModels([]);
    setSelectedModels(new Set());
    setModelFetchError(null);
    setModelSearchTerm("");
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

    setIsBatchTesting(true);

    // Create a map for quick lookup of index in main array
    const testIndices = new Map<string, number>();
    batchTestResults.forEach((r, idx) => {
      testIndices.set(`${r.provider}-${r.model}`, idx);
    });

    // Test selected models in parallel
    const testPromises = selectedTests.map(async (testItem) => {
      const { provider, model } = testItem;
      const index = testIndices.get(`${provider}-${model}`);

      if (index === undefined) return { success: false };

      // Update status to testing
      setBatchTestResults(prev => {
        const updated = [...prev];
        if (updated[index]) {
          updated[index] = { ...updated[index], status: "testing", timestamp: Date.now() };
        }
        return updated;
      });

      try {
        const result = await api.testModel(provider, model, config?.TEST_PROMPT);
        // Update status to success or error
        setBatchTestResults(prev => {
          const updated = [...prev];
          if (updated[index]) {
            updated[index] = {
              provider,
              model,
              status: result?.success ? "success" : "error",
              message: result?.error || undefined,
              response: result?.response || undefined,
              timestamp: Date.now(),
            };
          }
          return updated;
        });
        return { success: true };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        // Update status to error
        setBatchTestResults(prev => {
          const updated = [...prev];
          if (updated[index]) {
            updated[index] = {
              provider,
              model,
              status: "error",
              message: errorMsg,
              timestamp: Date.now(),
            };
          }
          return updated;
        });
        return { success: false };
      }
    });

    // Wait for all tests to complete
    await Promise.all(testPromises);
    setIsBatchTesting(false);
  };

  const handleBatchTestAll = async () => {
    // Collect all models from all providers
    const allTests: Array<{ provider: string; model: string }> = [];
    for (const provider of validProviders) {
      if (provider.name && provider.models) {
        for (const model of provider.models) {
          allTests.push({ provider: provider.name, model });
        }
      }
    }

    if (allTests.length === 0) {
      showToast("No models to test", "warning");
      return;
    }

    // Merge with existing results to preserve history
    const existingMap = new Map<string, BatchTestResult>();
    batchTestResults.forEach(r => {
      existingMap.set(`${r.provider}-${r.model}`, r);
    });

    const newResults: BatchTestResult[] = [];

    // Add all current models, preserving existing results if available
    allTests.forEach(({ provider, model }) => {
      const key = `${provider}-${model}`;
      if (existingMap.has(key)) {
        newResults.push(existingMap.get(key)!);
      } else {
        newResults.push({
          provider,
          model,
          status: "idle",
        });
      }
    });

    setBatchTestResults(newResults);
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
              size="sm"
              onClick={handleBatchTestAll}
              className="gap-1 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-300"
            >
              <Play className="h-4 w-4" />
              Test All
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
      <Dialog open={editingProviderIndex !== null} onOpenChange={(open) => {
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
                    const apiKeys = Array.isArray(editingProvider.api_key)
                      ? editingProvider.api_key
                      : [editingProvider.api_key || ''];

                    return apiKeys.map((key, keyIndex) => (
                      <div key={keyIndex} className="relative">
                        <Input
                          id={`api_key_${keyIndex}`}
                          type={showApiKey[`${editingProviderIndex}_${keyIndex}`] ? "text" : "password"}
                          value={key || ''}
                          onChange={(e) => {
                            const newKeys = [...apiKeys];
                            newKeys[keyIndex] = e.target.value;
                            // If only one key and it's the same as the original, keep as string
                            if (newKeys.length === 1 && !Array.isArray(editingProvider.api_key)) {
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
                          {apiKeys.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => {
                                const newKeys = apiKeys.filter((_, i) => i !== keyIndex);
                                handleProviderChange(editingProviderIndex, 'api_key', newKeys.length === 1 ? newKeys[0] : newKeys);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ));
                  })()}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      const apiKeys = Array.isArray(editingProvider.api_key)
                        ? [...editingProvider.api_key, '']
                        : [editingProvider.api_key || '', ''];
                      handleProviderChange(editingProviderIndex, 'api_key', apiKeys);
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
                <Label htmlFor="models">{t("providers.models")}</Label>
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      {hasFetchedModels[editingProviderIndex] ? (
                        <ComboInput
                          ref={comboInputRef}
                          options={(editingProvider.models || []).map((model: string) => ({ label: model, value: model }))}
                          value=""
                          onChange={() => {
                            // 只更新输入值，不添加模型
                          }}
                          onEnter={(value) => {
                            if (editingProviderIndex !== null) {
                              handleAddModel(editingProviderIndex, value);
                            }
                          }}
                          inputPlaceholder={t("providers.models_placeholder")}
                        />
                      ) : (
                        <Input
                          id="models"
                          placeholder={t("providers.models_placeholder")}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && e.currentTarget.value.trim() && editingProviderIndex !== null) {
                              handleAddModel(editingProviderIndex, e.currentTarget.value);
                              e.currentTarget.value = '';
                            }
                          }}
                        />
                      )}
                    </div>
                    <Button
                      onClick={() => {
                        if (hasFetchedModels[editingProviderIndex] && comboInputRef.current) {
                          // 使用ComboInput的逻辑
                          const comboInput = comboInputRef.current as unknown as { getCurrentValue(): string; clearInput(): void };
                          const currentValue = comboInput.getCurrentValue();
                          if (currentValue && currentValue.trim() && editingProviderIndex !== null) {
                            handleAddModel(editingProviderIndex, currentValue.trim());
                            // 清空ComboInput
                            comboInput.clearInput();
                          }
                        } else {
                          // 使用普通Input的逻辑
                          const input = document.getElementById('models') as HTMLInputElement;
                          if (input && input.value.trim() && editingProviderIndex !== null) {
                            handleAddModel(editingProviderIndex, input.value);
                            input.value = '';
                          }
                        }
                      }}
                    >
                      {t("providers.add_model")}
                    </Button>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            onClick={handleFetchModels}
                            disabled={isFetchingModels}
                          >
                            {isFetchingModels ? "..." : "从端点获取"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>从 /v1/models 获取可用模型列表</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-2">
                    {(editingProvider.models || []).map((model: string, modelIndex: number) => (
                      <Badge key={modelIndex} variant="outline" className="font-normal flex items-center gap-1">
                        {model}
                        <button
                          type="button"
                          className="ml-1 rounded-full hover:bg-gray-200"
                          onClick={() => editingProviderIndex !== null && handleRemoveModel(editingProviderIndex, modelIndex)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                </div>
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
                  />
                </div>
                
                {/* Display existing transformers */}
                {editingProvider.transformer?.use && editingProvider.transformer.use.length > 0 && (
                  <div className="space-y-2 mt-2">
                    <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                    {editingProvider.transformer.use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => (
                      <div key={transformerIndex} className="border rounded-md p-3">
                        <div className="flex gap-2 items-center mb-2">
                          <div className="flex-1 bg-gray-50 rounded p-2 text-sm">
                            {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                          </div>
                          <Button 
                            variant="outline" 
                            size="icon"
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
                        <div className="mt-2 pl-4 border-l-2 border-gray-200">
                          <Label className="text-sm">{t("providers.transformer_parameters")}</Label>
                          <div className="space-y-2 mt-1">
                            <div className="flex gap-2">
                              <Input 
                                placeholder={t("providers.parameter_name")}
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
                  <div className="space-y-3">
                    {(editingProvider.models || []).map((model: string, modelIndex: number) => (
                      <div key={modelIndex} className="border rounded-md p-3">
                        <div className="font-medium text-sm mb-2">{model}</div>
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
                            />
                          </div>
                        </div>
                        
                        {/* Display existing transformers */}
                        {editingProvider.transformer?.[model]?.use && editingProvider.transformer[model].use.length > 0 && (
                          <div className="space-y-2 mt-2">
                            <div className="text-sm font-medium text-gray-700">{t("providers.selected_transformers")}</div>
                            {editingProvider.transformer[model].use.map((transformer: string | (string | Record<string, unknown> | { max_tokens: number })[], transformerIndex: number) => (
                              <div key={transformerIndex} className="border rounded-md p-3">
                                <div className="flex gap-2 items-center mb-2">
                                  <div className="flex-1 bg-gray-50 rounded p-2 text-sm">
                                    {typeof transformer === 'string' ? transformer : Array.isArray(transformer) ? String(transformer[0]) : String(transformer)}
                                  </div>
                                  <Button 
                                    variant="outline" 
                                    size="icon"
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
                                <div className="mt-2 pl-4 border-l-2 border-gray-200">
                                  <Label className="text-sm">{t("providers.transformer_parameters")}</Label>
                                  <div className="space-y-2 mt-1">
                                    <div className="flex gap-2">
                                      <Input 
                                        placeholder={t("providers.parameter_name")}
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

      {/* Model Selection Dialog */}
      <Dialog open={showModelSelectDialog} onOpenChange={handleCancelModelSelection}>
        <DialogContent className="max-h-[80vh] flex flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>选择模型</DialogTitle>
            <DialogDescription>
              从端点获取的可用模型列表，勾选要添加的模型
            </DialogDescription>
          </DialogHeader>
          {modelFetchError ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-600">{modelFetchError}</p>
            </div>
          ) : (
            <div className="flex-grow overflow-y-auto">
              <div className="mb-4 flex items-center gap-2 border-b pb-4">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  <Input
                    placeholder="搜索模型..."
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
                  <span className="text-sm">全选</span>
                </label>
                <span className="text-sm text-gray-500">
                  已选择 {selectedModels.size} / {filteredModels.length} 个模型
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
              取消
            </Button>
            <Button onClick={handleConfirmModelSelection} disabled={selectedModels.size === 0}>
              确认添加 ({selectedModels.size})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Test Results Dialog */}
      <BatchTestDialog
        open={showBatchTestDialog}
        onClose={() => setShowBatchTestDialog(false)}
        results={batchTestResults}
        title="Batch Test Results"
        onRunTests={handleRunBatchTests}
        isRunning={isBatchTesting}
      />
    </Card>
  );
}
