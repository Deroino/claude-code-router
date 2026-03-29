import type { RequestStatsItem } from "@/hooks/useRequestStats";
import type { Provider, ModelGroup } from "@/types";
import { getRequestStatus } from "./requestStatus";

export const GROUP_REF_PREFIX = "group:";

export function isGroupReference(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(GROUP_REF_PREFIX);
}

export function parseGroupReference(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !isGroupReference(value)) {
    return null;
  }

  return value.slice(GROUP_REF_PREFIX.length);
}

export function buildGroupReference(groupName: string): string {
  return `${GROUP_REF_PREFIX}${groupName}`;
}

/**
 * Model option with status and stats information
 */
export interface ModelOption {
  value: string;
  label: string;
  successCount: number;
  status: 'success' | 'error' | 'neutral';
  isGroup?: boolean;
}

/**
 * Get request stats for a specific model
 */
function getModelStats(
  requestStats: RequestStatsItem[] | undefined,
  providerName: string,
  modelName: string
) {
  return requestStats?.find(s => s.provider === providerName && s.model === modelName);
}

/**
 * Generate model options with status and success count from providers
 *
 * @param providers - Array of provider configurations
 * @param requestStats - Array of request statistics
 * @returns Sorted array of model options with status info
 */
export function generateModelOptions(
  providers: Provider[],
  requestStats?: RequestStatsItem[]
): ModelOption[] {
  return providers.flatMap((provider) => {
    if (!provider) return [];

    const models = Array.isArray(provider.models) ? provider.models : [];
    const providerName = provider.name || "Unknown Provider";

    return models.map((model) => {
      const stats = getModelStats(requestStats, providerName, model || "Unknown Model");
      const successCount = stats?.success || 0;
      const status = getRequestStatus(requestStats, providerName, model || "Unknown Model");

      return {
        value: `${providerName},${model || "Unknown Model"}`,
        label: `${providerName}, ${model || "Unknown Model"}`,
        successCount,
        status,
      };
    });
  }).sort((a, b) => {
    // Sort by status first: success > neutral > error
    const statusOrder = { success: 0, neutral: 1, error: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    // Then by success count (descending)
    return b.successCount - a.successCount;
  });
}

/**
 * Generate group options from ModelGroups configuration
 *
 * @param modelGroups - Array of model group configurations
 * @returns Array of group options (without status/successCount)
 */
export function generateGroupOptions(modelGroups: ModelGroup[]): ModelOption[] {
  const groups = Array.isArray(modelGroups) ? modelGroups : [];
  return groups.map(group => ({
    value: buildGroupReference(group.name),
    label: `⊞ ${group.name} (${group.models?.length || 0})`,
    status: 'neutral' as const,
    successCount: 0,
    isGroup: true,
  }));
}

/**
 * Generate all options (groups + models) combined
 *
 * @param providers - Array of provider configurations
 * @param modelGroups - Array of model group configurations
 * @param requestStats - Array of request statistics
 * @returns Combined and sorted array of all options
 */
export function generateAllOptions(
  providers: Provider[],
  modelGroups: any[],
  requestStats?: RequestStatsItem[]
): ModelOption[] {
  const groupOptions = generateGroupOptions(modelGroups);
  const modelOptions = generateModelOptions(providers, requestStats);
  return [...groupOptions, ...modelOptions];
}