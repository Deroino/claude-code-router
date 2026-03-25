import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Plus, Pencil, Trash2, X, Layers, Check } from "lucide-react";
import { useConfig } from "./ConfigProvider";
import type { ModelGroup, Provider } from "@/types";
import type { RequestStatsItem } from "@/hooks/useRequestStats";
import { generateModelOptions } from "@/lib/modelOptions";
import { getRequestStatus, getStatusBadgeClasses } from "@/lib/requestStatus";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ModelGroupsProps {
  requestStats?: RequestStatsItem[];
  hoveredModel?: { provider: string | null; model: string | null } | null;
  onHoverModel?: (provider: string | null, model: string | null) => void;
}

const GROUP_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export function ModelGroups({ requestStats, hoveredModel, onHoverModel }: ModelGroupsProps) {
  const { t } = useTranslation();
  const { config, setConfig } = useConfig();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingData, setEditingData] = useState<ModelGroup | null>(null);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [nameError, setNameError] = useState<string>("");

  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between border-b p-4">
          <CardTitle className="text-lg">{t("groups.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  const groups: ModelGroup[] = Array.isArray(config.ModelGroups) ? config.ModelGroups : [];
  const providers: Provider[] = Array.isArray(config.Providers) ? config.Providers : [];

  // Aggregate success/fail counts for a ModelGroup from its child models
  const getGroupStats = (group: ModelGroup) => {
    if (!requestStats || !group.models || group.models.length === 0) {
      return { success: 0, fail: 0, rate: -1 };
    }

    const totals = group.models.reduce(
      (acc, modelStr) => {
        const [provider, ...modelParts] = modelStr.split(',');
        const model = modelParts.join(',');
        const stat = requestStats.find(
          s => s.provider === provider && s.model === model
        );
        return {
          success: acc.success + (stat?.success || 0),
          fail: acc.fail + (stat?.fail || 0),
        };
      },
      { success: 0, fail: 0 }
    );

    const total = totals.success + totals.fail;
    const rate = total > 0 ? Math.round((totals.success / total) * 100) : -1;
    return { ...totals, rate };
  };

  // Generate model options from providers using shared utility function
  const allModelOptions = generateModelOptions(providers, requestStats);

  // Get all models that are already used in other model groups
  const getUsedModelsInOtherGroups = (excludeGroupIndex: number): Set<string> => {
    const usedModels = new Set<string>();
    groups.forEach((group, index) => {
      if (index !== excludeGroupIndex && group.models) {
        group.models.forEach(model => usedModels.add(model));
      }
    });
    return usedModels;
  };

  // Filter model options: exclude already selected + exclude models in other groups
  const getModelOptionsForEditing = () => {
    const usedInOtherGroups = getUsedModelsInOtherGroups(editingIndex ?? -1);
    return allModelOptions.filter(opt => {
      // Exclude if already selected in current group
      if (editingData?.models.includes(opt.value)) return false;
      // Exclude if used in other model groups
      if (usedInOtherGroups.has(opt.value)) return false;
      return true;
    });
  };

  // Check if a group name is used in Router config
  const getGroupUsageScenarios = (groupName: string): string[] => {
    const router = config.Router;
    if (!router) return [];
    const scenarios: string[] = [];
    const groupRef = `group:${groupName}`;
    if (router.default === groupRef) scenarios.push("default");
    if (router.background === groupRef) scenarios.push("background");
    if (router.think === groupRef) scenarios.push("think");
    if (router.longContext === groupRef) scenarios.push("longContext");
    if (router.webSearch === groupRef) scenarios.push("webSearch");
    if (router.image === groupRef) scenarios.push("image");
    if (router.compact === groupRef) scenarios.push("compact");
    return scenarios;
  };

  const handleAdd = () => {
    setEditingData({ name: "", models: [] });
    setEditingIndex(groups.length);
    setIsNew(true);
    setNameError("");
  };

  const handleEdit = (index: number) => {
    setEditingData(JSON.parse(JSON.stringify(groups[index])));
    setEditingIndex(index);
    setIsNew(false);
    setNameError("");
  };

  const handleDelete = (index: number) => {
    const newGroups = [...groups];
    newGroups.splice(index, 1);
    setConfig({ ...config, ModelGroups: newGroups });
    setDeletingIndex(null);
  };

  const validateName = (name: string): boolean => {
    if (!name.trim()) {
      setNameError(t("groups.name_required"));
      return false;
    }
    if (!GROUP_NAME_REGEX.test(name)) {
      setNameError(t("groups.name_invalid"));
      return false;
    }
    // Check duplicate (exclude current editing group)
    const isDuplicate = groups.some(
      (g, i) => g.name === name && i !== (isNew ? -1 : editingIndex)
    );
    if (isDuplicate) {
      setNameError(t("groups.name_duplicate"));
      return false;
    }
    setNameError("");
    return true;
  };

  const handleSave = () => {
    if (!editingData || editingIndex === null) return;
    if (!validateName(editingData.name)) return;

    const newGroups = [...groups];
    if (isNew) {
      newGroups.push(editingData);
    } else {
      newGroups[editingIndex] = editingData;
    }
    setConfig({ ...config, ModelGroups: newGroups });
    setEditingIndex(null);
    setEditingData(null);
    setIsNew(false);
  };

  const handleCancel = () => {
    setEditingIndex(null);
    setEditingData(null);
    setIsNew(false);
    setNameError("");
  };

  const handleAddModel = (modelValue: string) => {
    if (!editingData) return;
    if (editingData.models.includes(modelValue)) return;
    setEditingData({
      ...editingData,
      models: [...editingData.models, modelValue],
    });
  };

  const handleRemoveModel = (modelValue: string) => {
    if (!editingData) return;
    setEditingData({
      ...editingData,
      models: editingData.models.filter((m) => m !== modelValue),
    });
  };

  // Handle hover on combobox dropdown item
  const handleComboboxItemHover = (modelValue: string | null) => {
    if (!onHoverModel) return;

    if (modelValue && modelValue.includes(',')) {
      const [provider, ...modelParts] = modelValue.split(',');
      const model = modelParts.join(',');
      if (provider && model) {
        onHoverModel(provider, model);
        return;
      }
    }
    onHoverModel(null, null);
  };

  // Construct the hovered value for highlighting
  const hoveredValue = hoveredModel?.provider && hoveredModel?.model
    ? `${hoveredModel.provider},${hoveredModel.model}`
    : undefined;

  return (
    <Card className="flex h-full flex-col rounded-lg border shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between border-b p-4">
        <CardTitle className="text-lg">
          {t("groups.title")}{" "}
          <span className="text-sm font-normal text-gray-500">
            ({groups.length})
          </span>
        </CardTitle>
        <Button onClick={handleAdd} size="sm">
          <Plus className="h-4 w-4 mr-1.5" />
          {t("groups.add")}
        </Button>
      </CardHeader>

      <CardContent className="flex-grow overflow-y-auto p-4">
        {groups.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {t("groups.no_groups")}
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group, index) => {
              const usageScenarios = getGroupUsageScenarios(group.name);
              const groupStats = getGroupStats(group);
              return (
                <div
                  key={`${group.name}-${index}`}
                  className="rounded-md border bg-white p-4 transition-all hover:shadow-md"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2">
                        <Layers className="h-4 w-4 text-blue-500 shrink-0" />
                        <p className="font-semibold text-sm truncate">{group.name}</p>
                        {usageScenarios.length > 0 && (
                          <Badge variant="outline" className="text-xs text-blue-600 border-blue-200 bg-blue-50 shrink-0">
                            {usageScenarios.join(", ")}
                          </Badge>
                        )}
                        {/* Aggregated stats from child models */}
                        <div className="flex items-center gap-1.5 text-[10px] leading-none font-semibold text-gray-500 shrink-0 ml-auto mr-1">
                          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm">
                            <Check className="h-3 w-3 text-emerald-500" />
                            <span className="text-emerald-600">{groupStats.success}</span>
                          </div>
                          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-sm">
                            <X className="h-3 w-3 text-rose-500" />
                            <span className="text-rose-600">{groupStats.fail}</span>
                          </div>
                          {groupStats.rate >= 0 && (
                            <div className={`px-1.5 py-0.5 rounded-sm text-[10px] font-bold ${
                              groupStats.rate >= 80
                                ? 'text-emerald-600 bg-emerald-50'
                                : groupStats.rate >= 50
                                  ? 'text-amber-600 bg-amber-50'
                                  : 'text-rose-600 bg-rose-50'
                            }`}>
                              {groupStats.rate}%
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(group.models || []).map((modelStr) => {
                          const [provider, ...modelParts] = modelStr.split(",");
                          const model = modelParts.join(",");
                          const status = getRequestStatus(requestStats, provider, model);
                          return (
                            <Badge
                              key={modelStr}
                              variant="outline"
                              className={`text-xs ${getStatusBadgeClasses(status)}`}
                            >
                              {modelStr.replace(",", ", ")}
                            </Badge>
                          );
                        })}
                        {(!group.models || group.models.length === 0) && (
                          <span className="text-xs text-gray-400">{t("groups.no_models")}</span>
                        )}
                      </div>
                    </div>
                    <div className="ml-3 flex gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleEdit(index)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-red-500 hover:text-red-700"
                        onClick={() => setDeletingIndex(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Edit/Create Dialog */}
      <Dialog open={editingIndex !== null} onOpenChange={handleCancel}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isNew ? t("groups.add") : t("groups.edit")}</DialogTitle>
          </DialogHeader>
          {editingData && (
            <div className="space-y-4 py-4">
              {/* Group Name */}
              <div className="space-y-2">
                <Label htmlFor="group-name">{t("groups.name")}</Label>
                <Input
                  id="group-name"
                  value={editingData.name}
                  onChange={(e) => {
                    setEditingData({ ...editingData, name: e.target.value });
                    if (nameError) validateName(e.target.value);
                  }}
                  placeholder={t("groups.name_placeholder")}
                  className={nameError ? "border-red-500" : ""}
                />
                {nameError && (
                  <p className="text-sm text-red-500">{nameError}</p>
                )}
              </div>

              {/* Model Selection */}
              <div className="space-y-2">
                <Label>{t("groups.models")}</Label>
                <Combobox
                  options={getModelOptionsForEditing()}
                  value=""
                  onChange={(value) => {
                    if (value) handleAddModel(value);
                  }}
                  placeholder={t("groups.select_model")}
                  searchPlaceholder={t("groups.search_model")}
                  emptyPlaceholder={t("router.noModelFound")}
                  hoveredValue={hoveredValue}
                  onItemHover={handleComboboxItemHover}
                  modal={true}
                />
              </div>

              {/* Selected Models List */}
              <div className="space-y-2">
                {editingData.models.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-3">
                    {t("groups.no_models")}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {editingData.models.map((modelStr) => {
                      const [provider, ...modelParts] = modelStr.split(",");
                      const model = modelParts.join(",");
                      const status = getRequestStatus(requestStats, provider, model);
                      return (
                        <Badge
                          key={modelStr}
                          variant="outline"
                          className={`flex items-center gap-1 pr-1 py-1 ${getStatusBadgeClasses(status)}`}
                        >
                          <span className="text-xs">{modelStr.replace(",", ", ")}</span>
                          <button
                            onClick={() => handleRemoveModel(modelStr)}
                            className="ml-0.5 rounded-full p-0.5 hover:bg-gray-200 transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={handleCancel}>
              {t("app.cancel")}
            </Button>
            <Button onClick={handleSave}>{t("app.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deletingIndex !== null}
        onOpenChange={() => setDeletingIndex(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("groups.delete")}</DialogTitle>
            <DialogDescription>
              {t("groups.delete_confirm")}
              {deletingIndex !== null &&
                getGroupUsageScenarios(groups[deletingIndex]?.name || "").length > 0 && (
                  <span className="block mt-2 text-amber-600 font-medium">
                    ⚠️ {t("groups.in_use_warning")}
                  </span>
                )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingIndex(null)}
            >
              {t("app.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                deletingIndex !== null && handleDelete(deletingIndex)
              }
            >
              {t("app.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
