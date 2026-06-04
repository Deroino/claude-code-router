import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useConfig } from "./ConfigProvider";
import { Combobox } from "./ui/combobox";
import type { RequestStatsItem } from "@/hooks/useRequestStats";
import { generateAllOptions, isGroupReference } from "@/lib/modelOptions";
import { Play } from "lucide-react";

interface RouterProps {
  hoveredModel?: { provider: string | null; model: string | null };
  onHoverModel?: (provider: string | null, model: string | null) => void;
  requestStats?: RequestStatsItem[];
  onBatchTestSelected?: () => void;
}

export function Router({ hoveredModel, onHoverModel, requestStats, onBatchTestSelected }: RouterProps) {
  const { t } = useTranslation();
  const { config, setConfig } = useConfig();

  // Handle case where config is null or undefined
  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="border-b p-4">
          <CardTitle className="text-lg">{t("router.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading router configuration...</div>
        </CardContent>
      </Card>
    );
  }

  // Handle case where config.Router is null or undefined
  const routerConfig = config.Router || {
    default: "",
    background: "",
    think: "",
    longContext: "",
    longContextThreshold: 60000,
    webSearch: "",
    image: "",
    compact: ""
  };

  const handleRouterChange = (field: string, value: string | number) => {
    // Handle case where config.Router might be null or undefined
    const currentRouter = config.Router || {};
    const newRouter = { ...currentRouter, [field]: value };
    setConfig({ ...config, Router: newRouter });
  };

  const handleForceUseImageAgentChange = (value: boolean) => {
    setConfig({ ...config, forceUseImageAgent: value });
  };

  // Parse model value and trigger hover event
  const handleLabelHover = (modelValue: string | undefined) => {
    console.log('[Router] handleLabelHover called:', { modelValue, hasCallback: !!onHoverModel });
    if (!onHoverModel) return;

    // Group references don't trigger single model highlighting
    if (isGroupReference(modelValue)) {
      onHoverModel(null, null);
      return;
    }

    if (typeof modelValue === 'string' && modelValue.includes(',')) {
      const [provider, ...modelParts] = modelValue.split(',');
      const model = modelParts.join(','); // Handle model names that might contain commas
      console.log('[Router] Parsed:', { provider, model });
      if (provider && model) {
        onHoverModel(provider, model);
        return;
      }
    }
    onHoverModel(null, null);
  };

  const handleLabelLeave = () => {
    if (onHoverModel) {
      onHoverModel(null, null);
    }
  };

  // Handle hover on combobox dropdown item
  const handleComboboxItemHover = (modelValue: string | null) => {
    console.log('[Router] handleComboboxItemHover called:', { modelValue, hasCallback: !!onHoverModel });
    if (!onHoverModel) return;

    // Group references don't trigger single model highlighting
    if (isGroupReference(modelValue)) {
      onHoverModel(null, null);
      return;
    }

    if (typeof modelValue === 'string' && modelValue.includes(',')) {
      const [provider, ...modelParts] = modelValue.split(',');
      const model = modelParts.join(',');
      console.log('[Router] Parsed combobox item:', { provider, model });
      if (provider && model) {
        onHoverModel(provider, model);
        return;
      }
    }
    onHoverModel(null, null);
  };

  // Handle case where config.Providers might be null or undefined
  const providers = Array.isArray(config.Providers) ? config.Providers : [];

  // Generate options using shared utility functions
  const allOptions = generateAllOptions(providers, config.ModelGroups || [], requestStats);

  // Construct the hovered value for highlighting
  const hoveredValue = hoveredModel?.provider && hoveredModel?.model
    ? `${hoveredModel.provider},${hoveredModel.model}`
    : undefined;

  return (
    <Card className="flex h-full flex-col rounded-lg border shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between border-b p-4">
        <CardTitle className="text-lg">{t("router.title")}</CardTitle>
        {onBatchTestSelected && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBatchTestSelected}
          >
            <Play className="h-4 w-4 mr-1.5" />
            {t("router.test_selected")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex-grow space-y-5 overflow-y-auto p-4">
        <div className="space-y-2">
          <Label
            onMouseEnter={() => handleLabelHover(routerConfig.default)}
            onMouseLeave={handleLabelLeave}
            className="cursor-pointer"
          >
            {t("router.default")}
          </Label>
          <Combobox
            options={allOptions}
            value={routerConfig.default || ""}
            onChange={(value) => handleRouterChange("default", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
            hoveredValue={hoveredValue}
            onItemHover={handleComboboxItemHover}
            modal={false}
          />
        </div>
        <div className="space-y-2">
          <Label
            onMouseEnter={() => handleLabelHover(routerConfig.background)}
            onMouseLeave={handleLabelLeave}
            className="cursor-pointer"
          >
            {t("router.background")}
          </Label>
          <Combobox
            options={allOptions}
            value={routerConfig.background || ""}
            onChange={(value) => handleRouterChange("background", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
            hoveredValue={hoveredValue}
            onItemHover={handleComboboxItemHover}
            modal={false}
          />
        </div>
        <div className="space-y-2">
          <Label
            onMouseEnter={() => handleLabelHover(routerConfig.think)}
            onMouseLeave={handleLabelLeave}
            className="cursor-pointer"
          >
            {t("router.think")}
          </Label>
          <Combobox
            options={allOptions}
            value={routerConfig.think || ""}
            onChange={(value) => handleRouterChange("think", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
            hoveredValue={hoveredValue}
            onItemHover={handleComboboxItemHover}
            modal={false}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Label
                onMouseEnter={() => handleLabelHover(routerConfig.longContext)}
                onMouseLeave={handleLabelLeave}
                className="cursor-pointer"
              >
                {t("router.longContext")}
              </Label>
              <Combobox
                options={allOptions}
                value={routerConfig.longContext || ""}
                onChange={(value) => handleRouterChange("longContext", value)}
                placeholder={t("router.selectModel")}
                searchPlaceholder={t("router.searchModel")}
                emptyPlaceholder={t("router.noModelFound")}
                hoveredValue={hoveredValue}
                onItemHover={handleComboboxItemHover}
                modal={false}
              />
            </div>
            <div className="w-48">
              <Label>{t("router.longContextThreshold")}</Label>
              <Input
                type="number"
                value={routerConfig.longContextThreshold || 60000}
                onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value) || 60000)}
                placeholder="60000"
              />
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label
            onMouseEnter={() => handleLabelHover(routerConfig.webSearch)}
            onMouseLeave={handleLabelLeave}
            className="cursor-pointer"
          >
            {t("router.webSearch")}
          </Label>
          <Combobox
            options={allOptions}
            value={routerConfig.webSearch || ""}
            onChange={(value) => handleRouterChange("webSearch", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
            hoveredValue={hoveredValue}
            onItemHover={handleComboboxItemHover}
            modal={false}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Label
                onMouseEnter={() => handleLabelHover(routerConfig.image)}
                onMouseLeave={handleLabelLeave}
                className="cursor-pointer"
              >
                {t("router.image")} (beta)
              </Label>
              <Combobox
                options={allOptions}
                value={routerConfig.image || ""}
                onChange={(value) => handleRouterChange("image", value)}
                placeholder={t("router.selectModel")}
                searchPlaceholder={t("router.searchModel")}
                emptyPlaceholder={t("router.noModelFound")}
                hoveredValue={hoveredValue}
                onItemHover={handleComboboxItemHover}
                modal={false}
              />
            </div>
            <div className="w-48">
              <Label htmlFor="forceUseImageAgent">{t("router.forceUseImageAgent")}</Label>
              <select
                id="forceUseImageAgent"
                value={config.forceUseImageAgent ? "true" : "false"}
                onChange={(e) => handleForceUseImageAgentChange(e.target.value === "true")}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="false">{t("common.no")}</option>
                <option value="true">{t("common.yes")}</option>
              </select>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label
            onMouseEnter={() => handleLabelHover(routerConfig.compact)}
            onMouseLeave={handleLabelLeave}
            className="cursor-pointer"
          >
            {t("router.compact")}
          </Label>
          <Combobox
            options={allOptions}
            value={routerConfig.compact || ""}
            onChange={(value) => handleRouterChange("compact", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
            hoveredValue={hoveredValue}
            onItemHover={handleComboboxItemHover}
            modal={false}
          />
        </div>
      </CardContent>
    </Card>
  );
}
