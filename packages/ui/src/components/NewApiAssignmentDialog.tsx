import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { X, Search, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ApiKeyEntry } from "@/types";

// Fixed color palette for groups (8 colors + gray for ungrouped)
const GROUP_COLORS: Record<string, { bg: string; text: string; border: string; hoverBg: string }> = {
  blue:    { bg: "bg-blue-100 dark:bg-blue-900/30",    text: "text-blue-700 dark:text-blue-300",    border: "border-blue-300 dark:border-blue-700",    hoverBg: "hover:bg-blue-200 dark:hover:bg-blue-900/50" },
  emerald: { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-300 dark:border-emerald-700", hoverBg: "hover:bg-emerald-200 dark:hover:bg-emerald-900/50" },
  amber:   { bg: "bg-amber-100 dark:bg-amber-900/30",   text: "text-amber-700 dark:text-amber-300",   border: "border-amber-300 dark:border-amber-700",   hoverBg: "hover:bg-amber-200 dark:hover:bg-amber-900/50" },
  purple:  { bg: "bg-purple-100 dark:bg-purple-900/30",  text: "text-purple-700 dark:text-purple-300",  border: "border-purple-300 dark:border-purple-700",  hoverBg: "hover:bg-purple-200 dark:hover:bg-purple-900/50" },
  rose:    { bg: "bg-rose-100 dark:bg-rose-900/30",    text: "text-rose-700 dark:text-rose-300",    border: "border-rose-300 dark:border-rose-700",    hoverBg: "hover:bg-rose-200 dark:hover:bg-rose-900/50" },
  cyan:    { bg: "bg-cyan-100 dark:bg-cyan-900/30",    text: "text-cyan-700 dark:text-cyan-300",    border: "border-cyan-300 dark:border-cyan-700",    hoverBg: "hover:bg-cyan-200 dark:hover:bg-cyan-900/50" },
  orange:  { bg: "bg-orange-100 dark:bg-orange-900/30",  text: "text-orange-700 dark:text-orange-300",  border: "border-orange-300 dark:border-orange-700",  hoverBg: "hover:bg-orange-200 dark:hover:bg-orange-900/50" },
  indigo:  { bg: "bg-indigo-100 dark:bg-indigo-900/30",  text: "text-indigo-700 dark:text-indigo-300",  border: "border-indigo-300 dark:border-indigo-700",  hoverBg: "hover:bg-indigo-200 dark:hover:bg-indigo-900/50" },
};
const COLOR_KEYS = Object.keys(GROUP_COLORS);

const UNGROUPED_COLOR = {
  bg: "bg-gray-100 dark:bg-gray-800/30",
  text: "text-gray-600 dark:text-gray-400",
  border: "border-gray-300 dark:border-gray-600",
  hoverBg: "hover:bg-gray-200 dark:hover:bg-gray-800/50",
};

type ColorStyle = typeof UNGROUPED_COLOR;

interface NewApiAssignmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pricingData: {
    group_ratio: Record<string, number>;
    data: Array<{ model_name: string; enable_groups: string[] }>;
  };
  apiKeys: (string | ApiKeyEntry)[];
  apiBaseUrl: string;
  existingModels: string[];
  onConfirm: (result: { updatedKeys: (string | ApiKeyEntry)[]; allModels: string[] }) => void;
  showToast: (msg: string, type: string) => string;
}

// Build group -> color mapping
function buildGroupColorMap(groups: string[]): Record<string, ColorStyle> {
  const map: Record<string, ColorStyle> = {};
  let colorIdx = 0;
  for (const g of groups) {
    if (g === "__ungrouped__") {
      map[g] = UNGROUPED_COLOR;
    } else {
      map[g] = GROUP_COLORS[COLOR_KEYS[colorIdx % COLOR_KEYS.length]];
      colorIdx++;
    }
  }
  return map;
}

// Build model -> groups mapping from pricing data
function buildModelGroupsMap(
  pricingData: NewApiAssignmentDialogProps["pricingData"]
): { modelGroups: Record<string, string[]>; groupModels: Record<string, string[]>; allModels: string[] } {
  const groupModels: Record<string, string[]> = {};
  const modelGroups: Record<string, string[]> = {};
  const allModelNames: string[] = [];
  const groupedModels = new Set<string>();

  for (const g of Object.keys(pricingData.group_ratio)) {
    groupModels[g] = [];
  }

  for (const model of pricingData.data) {
    if (!model.model_name) continue;
    allModelNames.push(model.model_name);
    modelGroups[model.model_name] = [];

    if (Array.isArray(model.enable_groups)) {
      for (const g of model.enable_groups) {
        if (groupModels[g]) {
          groupModels[g].push(model.model_name);
          modelGroups[model.model_name].push(g);
          groupedModels.add(model.model_name);
        }
      }
    }
  }

  const ungrouped: string[] = [];
  for (const name of allModelNames) {
    if (!groupedModels.has(name)) {
      ungrouped.push(name);
      modelGroups[name] = ["__ungrouped__"];
    }
  }
  if (ungrouped.length > 0) {
    groupModels["__ungrouped__"] = ungrouped;
  }

  return { modelGroups, groupModels, allModels: allModelNames };
}

// Mask API key for display
function maskKey(entry: string | ApiKeyEntry): string {
  const k = typeof entry === "string" ? entry : entry?.key || "";
  if (k.length <= 10) return "****";
  return `${k.substring(0, 6)}...${k.substring(k.length - 4)}`;
}

// Get color style for a model based on its primary group
function getModelColor(
  modelName: string,
  modelGroupsMap: Record<string, string[]>,
  groupColorMap: Record<string, ColorStyle>
): ColorStyle {
  const groups = modelGroupsMap[modelName] || [];
  if (groups.length > 0 && groupColorMap[groups[0]]) {
    return groupColorMap[groups[0]];
  }
  return UNGROUPED_COLOR;
}

export function NewApiAssignmentDialog({
  open,
  onOpenChange,
  pricingData,
  apiKeys,
  apiBaseUrl,
  existingModels,
  onConfirm,
  showToast,
}: NewApiAssignmentDialogProps) {
  const { t } = useTranslation();

  // Build data structures from pricing data (memoized to prevent infinite re-render loop)
  const { modelGroups: modelGroupsMap, groupModels, allModels } = useMemo(
    () => buildModelGroupsMap(pricingData),
    [pricingData]
  );
  const groupNames = useMemo(() => Object.keys(groupModels), [groupModels]);
  const groupColorMap = useMemo(() => buildGroupColorMap(groupNames), [groupNames]);

  // State
  const [searchTerm, setSearchTerm] = useState("");
  const [activeGroupFilter, setActiveGroupFilter] = useState<string | null>(null);
  const [keyAssignments, setKeyAssignments] = useState<Record<number, string[]>>({});
  const [keyLoadingStates, setKeyLoadingStates] = useState<Record<number, boolean>>({});
  const [keyErrorStates, setKeyErrorStates] = useState<Record<number, string | null>>({});

  // Native DnD state
  const [draggedModel, setDraggedModel] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<number | null>(null);

  // Stable refs for values used in the loading effect (avoids dependency hell)
  const apiKeysRef = useRef(apiKeys);
  const apiBaseUrlRef = useRef(apiBaseUrl);
  const allModelsRef = useRef(allModels);
  const pricingDataRef = useRef(pricingData);
  apiKeysRef.current = apiKeys;
  apiBaseUrlRef.current = apiBaseUrl;
  allModelsRef.current = allModels;
  pricingDataRef.current = pricingData;

  // Initialize keyAssignments from existing config when dialog opens
  useEffect(() => {
    if (!open) return;

    const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
    const initialAssignments: Record<number, string[]> = {};
    const loadingStates: Record<number, boolean> = {};
    const errorStates: Record<number, string | null> = {};

    // Build a map of provider-level existing models
    const providerModelSet = new Set(existingModels);

    keys.forEach((entry, idx) => {
      // Get existing models from ApiKeyEntry if available
      if (typeof entry === "object" && entry?.models && entry.models.length > 0) {
        initialAssignments[idx] = entry.models || [];
      } else if (providerModelSet.size > 0) {
        // If no key-specific models but provider has models, use those
        initialAssignments[idx] = Array.from(providerModelSet);
      } else {
        initialAssignments[idx] = [];
      }
      loadingStates[idx] = false;  // Start with loading=false
      errorStates[idx] = null;
    });

    setKeyAssignments(initialAssignments);
    setKeyLoadingStates(loadingStates);
    setKeyErrorStates(errorStates);
  }, [open, apiKeys, existingModels]);

  // Fetch models for a single key (triggered by button click)
  const fetchKeyModels = useCallback(async (keyIndex: number) => {
    const currentApiKeys = apiKeysRef.current;
    const currentApiBaseUrl = apiBaseUrlRef.current;
    const currentAllModels = allModelsRef.current;

    const keys = Array.isArray(currentApiKeys) ? currentApiKeys : [currentApiKeys];
    const entry = keys[keyIndex];
    const keyStr = typeof entry === "string" ? entry : entry?.key || "";

    if (!keyStr) {
      setKeyErrorStates((prev) => ({ ...prev, [keyIndex]: "Empty key" }));
      return;
    }

    // Set loading state for this key
    setKeyLoadingStates((prev) => ({ ...prev, [keyIndex]: true }));
    setKeyErrorStates((prev) => ({ ...prev, [keyIndex]: null }));

    try {
      const result = await api.fetchModels(currentApiBaseUrl, keyStr, true);
      console.log(`[NewApiAssignment] Key#${keyIndex} fetch result:`, {
        success: result.success,
        type: result.type,
        hasData: !!result.data,
        hasDataData: !!result.data?.data,
        error: result.error,
      });

      if (!result.success) {
        setKeyErrorStates((prev) => ({ ...prev, [keyIndex]: result.error || "Fetch failed" }));
        setKeyLoadingStates((prev) => ({ ...prev, [keyIndex]: false }));
        return;
      }

      // Extract model IDs from standard OpenAI /v1/models format
      let rawModels: string[] = [];
      if (result.data?.data && Array.isArray(result.data.data)) {
        rawModels = result.data.data.map((m: any) => m.id).filter(Boolean);
      } else if (Array.isArray(result.data)) {
        rawModels = result.data.map((m: any) => m.id || m).filter(Boolean);
      }

      const allPricingModels = new Set(currentAllModels);
      const matchedModels = rawModels.filter((id: string) => allPricingModels.has(id));
      console.log(`[NewApiAssignment] Key#${keyIndex}: raw=${rawModels.length}, matched=${matchedModels.length}`);

      // Use pricing-matched if available, otherwise use all raw models
      const finalModels = matchedModels.length > 0 ? matchedModels : rawModels;

      setKeyAssignments((prev) => ({ ...prev, [keyIndex]: finalModels }));
      setKeyLoadingStates((prev) => ({ ...prev, [keyIndex]: false }));
      setKeyErrorStates((prev) => ({ ...prev, [keyIndex]: null }));
    } catch (err: any) {
      console.error(`[NewApiAssignment] Key#${keyIndex} fetch error:`, err);
      setKeyErrorStates((prev) => ({ ...prev, [keyIndex]: err.message || "Failed" }));
      setKeyLoadingStates((prev) => ({ ...prev, [keyIndex]: false }));
    }
  }, []);

  // Native drag handlers for pool badges
  const handleDragStart = useCallback((e: React.DragEvent, modelName: string) => {
    e.dataTransfer.setData("text/plain", modelName);
    e.dataTransfer.effectAllowed = "copy";
    setDraggedModel(modelName);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedModel(null);
    setDropTargetKey(null);
  }, []);

  // Native drop handlers for key zones
  const handleDragOver = useCallback((e: React.DragEvent, keyIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropTargetKey(keyIndex);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent, keyIndex: number) => {
    // Only clear if leaving the drop zone (not entering a child)
    const relatedTarget = e.relatedTarget as Node;
    const currentTarget = e.currentTarget as Node;
    if (!currentTarget.contains(relatedTarget)) {
      if (dropTargetKey === keyIndex) setDropTargetKey(null);
    }
  }, [dropTargetKey]);

  const handleDrop = useCallback((e: React.DragEvent, keyIndex: number) => {
    e.preventDefault();
    const modelName = e.dataTransfer.getData("text/plain");
    if (modelName) {
      setKeyAssignments((prev) => {
        const current = prev[keyIndex] || [];
        if (current.includes(modelName)) return prev;
        return { ...prev, [keyIndex]: [...current, modelName] };
      });
    }
    setDropTargetKey(null);
    setDraggedModel(null);
  }, []);

  // Remove model from key
  const handleRemove = useCallback((keyIndex: number, modelName: string) => {
    setKeyAssignments((prev) => {
      const current = prev[keyIndex] || [];
      return { ...prev, [keyIndex]: current.filter((m) => m !== modelName) };
    });
  }, []);

  // Filter pool models
  const filteredPoolModels = allModels.filter((name) => {
    if (searchTerm && !name.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    if (activeGroupFilter) {
      const groups = modelGroupsMap[name] || [];
      if (!groups.includes(activeGroupFilter)) return false;
    }
    return true;
  });

  // Handle confirm
  const handleConfirm = () => {
    const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];

    const allAssignedModels = new Set<string>();
    Object.values(keyAssignments).forEach((models) => {
      models.forEach((m) => allAssignedModels.add(m));
    });

    console.log("[NewApiAssignment] Confirm:", {
      keyAssignments,
      allAssignedModels: Array.from(allAssignedModels),
      totalKeys: keys.length,
    });

    const updatedKeys = keys.map((entry, idx) => {
      const keyStr = typeof entry === "string" ? entry : entry?.key || "";
      const assignedModels = keyAssignments[idx] || [];

      if (assignedModels.length === 0) {
        return typeof entry === "string" ? entry : { ...entry, models: undefined };
      }

      return {
        key: keyStr,
        models: assignedModels,
      } as ApiKeyEntry;
    });

    onConfirm({
      updatedKeys,
      allModels: Array.from(allAssignedModels),
    });
  };

  // Total unique models summary
  const totalUniqueModels = new Set<string>();
  Object.values(keyAssignments).forEach((models) => {
    models.forEach((m) => totalUniqueModels.add(m));
  });

  const keys = Array.isArray(apiKeys) ? apiKeys : [apiKeys];

  // Determine drop zone highlight style
  const getDropZoneStyle = (keyIndex: number) => {
    if (dropTargetKey !== keyIndex || !draggedModel) return "";
    const currentModels = keyAssignments[keyIndex] || [];
    const isDuplicate = currentModels.includes(draggedModel);
    return isDuplicate
      ? "ring-2 ring-red-400 bg-red-50/50 dark:bg-red-900/20"
      : "ring-2 ring-blue-400 bg-blue-50/50 dark:bg-blue-900/20";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("newapi_assignment.title")}</DialogTitle>
          <DialogDescription>{t("newapi_assignment.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex-grow overflow-y-auto space-y-4 py-2">
          {/* Model Pool */}
          <div className="border rounded-lg p-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{t("newapi_assignment.model_pool")}</span>
              <span className="text-xs text-muted-foreground">
                ({filteredPoolModels.length} / {allModels.length})
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-6 text-xs px-2"
                onClick={() => {
                  const keysArr = Array.isArray(apiKeys) ? apiKeys : [apiKeys];
                  setKeyAssignments((prev) => {
                    const next = { ...prev };
                    keysArr.forEach((_, idx) => {
                      const existing = new Set(next[idx] || []);
                      allModels.forEach((m) => existing.add(m));
                      next[idx] = Array.from(existing);
                    });
                    return next;
                  });
                }}
              >
                {t("newapi_assignment.add_all_to_keys")}
              </Button>
            </div>

            {/* Search + Group Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                <Input
                  placeholder={t("newapi_assignment.search_placeholder")}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 h-8 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                <Badge
                  variant={activeGroupFilter === null ? "default" : "outline"}
                  className="cursor-pointer text-xs px-2 py-0.5 select-none"
                  onClick={() => setActiveGroupFilter(null)}
                >
                  {t("newapi_assignment.all_groups")}
                </Badge>
                {groupNames.map((g) => {
                  const color = groupColorMap[g] || UNGROUPED_COLOR;
                  const isActive = activeGroupFilter === g;
                  return (
                    <Badge
                      key={g}
                      variant={isActive ? "default" : "outline"}
                      className={`cursor-pointer text-xs px-2 py-0.5 select-none ${
                        isActive ? "" : `${color.bg} ${color.text} ${color.border} ${color.hoverBg}`
                      }`}
                      onClick={() => setActiveGroupFilter(isActive ? null : g)}
                    >
                      {g === "__ungrouped__" ? t("newapi_assignment.ungrouped") : g}
                      <span className="ml-1 opacity-60">({(groupModels[g] || []).length})</span>
                    </Badge>
                  );
                })}
              </div>
            </div>

            {/* Model badges (draggable via native HTML5 DnD) */}
            <div className="flex flex-wrap gap-1 max-h-60 overflow-y-auto">
              {filteredPoolModels.map((name) => {
                const colorStyle = getModelColor(name, modelGroupsMap, groupColorMap);
                return (
                  <div
                    key={name}
                    draggable
                    onDragStart={(e) => handleDragStart(e, name)}
                    onDragEnd={handleDragEnd}
                  >
                    <Badge
                      variant="outline"
                      className={`cursor-grab select-none text-xs px-2 py-0.5 border ${colorStyle.bg} ${colorStyle.text} ${colorStyle.border} ${
                        draggedModel === name ? "opacity-40" : "opacity-100"
                      } transition-opacity`}
                    >
                      {name}
                    </Badge>
                  </div>
                );
              })}
              {filteredPoolModels.length === 0 && (
                <p className="text-sm text-muted-foreground italic py-2 w-full text-center">
                  No models found
                </p>
              )}
            </div>
          </div>

          {/* Key Drop Zones */}
          <div className="space-y-3">
            {keys.map((entry, idx) => {
              const models = keyAssignments[idx] || [];
              const loading = keyLoadingStates[idx] || false;
              const error = keyErrorStates[idx] || null;
              const keyLabel = `${t("newapi_assignment.key_zone_title", { index: idx + 1 })} (${maskKey(entry)})`;

              return (
                <div
                  key={idx}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDragLeave={(e) => handleDragLeave(e, idx)}
                  onDrop={(e) => handleDrop(e, idx)}
                  className={`border rounded-lg p-3 space-y-2 transition-all min-h-[80px] ${getDropZoneStyle(idx)}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{keyLabel}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t("newapi_assignment.models_count", { count: models.length })}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs px-2"
                        onClick={() => fetchKeyModels(idx)}
                        disabled={loading}
                      >
                        {loading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          t("newapi_assignment.fetch_models")
                        )}
                      </Button>
                    </div>
                  </div>

                  {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t("newapi_assignment.loading")}
                    </div>
                  ) : error ? (
                    <div className="text-sm text-red-500 py-2">{t("newapi_assignment.error")}: {error}</div>
                  ) : models.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic py-2">
                      {t("newapi_assignment.key_zone_empty")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                      {models.map((m) => {
                        const colorStyle = getModelColor(m, modelGroupsMap, groupColorMap);
                        return (
                          <Badge
                            key={m}
                            variant="outline"
                            className={`text-xs px-2 py-0.5 border ${colorStyle.bg} ${colorStyle.text} ${colorStyle.border}`}
                          >
                            {m}
                            <button
                              onClick={() => handleRemove(idx, m)}
                              className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Summary */}
          <div className="border-t pt-3">
            <p className="text-sm text-muted-foreground">
              {t("newapi_assignment.total_summary", { count: totalUniqueModels.size })}
            </p>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("newapi_assignment.cancel")}
          </Button>
          <Button onClick={handleConfirm}>{t("newapi_assignment.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
