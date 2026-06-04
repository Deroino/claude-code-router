import type { RequestStatsItem } from "@/hooks/useRequestStats";

export type RequestStatus = "success" | "error" | "neutral";

/**
 * Get the status of a provider:model based on last request timestamps
 * Returns "success" if last success is more recent, "error" if last failure is more recent
 * Only considers aggregate stats (excludes per-key entries)
 */
export function getRequestStatus(
  requestStats: RequestStatsItem[] | undefined,
  provider: string,
  model: string
): RequestStatus {
  if (!requestStats) return "neutral";

  const stats = requestStats.find(
    (s) => s.provider === provider && s.model === model && s.keyIndex === undefined
  );
  if (!stats) return "neutral";

  const lastSuccess = stats.lastSuccessRequest;
  const lastFailure = stats.lastFailureRequest;
  const lastSuccessAt = stats.lastSuccessAt || lastSuccess?.timestamp;
  const lastFailureAt = stats.lastFailureAt || lastFailure?.timestamp;

  if (!lastSuccessAt && !lastFailureAt) return "neutral";

  const successTime = lastSuccessAt
    ? new Date(lastSuccessAt).getTime()
    : 0;
  const failureTime = lastFailureAt
    ? new Date(lastFailureAt).getTime()
    : 0;

  if (failureTime > successTime) return "error";
  return "success";
}

/**
 * Get Tailwind background classes based on request status
 */
export function getStatusBackgroundClass(status: RequestStatus): string {
  switch (status) {
    case "success":
      return "bg-green-100";
    case "error":
      return "bg-red-100";
    default:
      return "bg-gray-50";
  }
}

/**
 * Get Tailwind border classes based on request status
 */
export function getStatusBorderClass(status: RequestStatus): string {
  switch (status) {
    case "success":
      return "border-green-300";
    case "error":
      return "border-red-300";
    default:
      return "border-gray-200";
  }
}

/**
 * Get Tailwind text classes based on request status
 */
export function getStatusTextClass(status: RequestStatus): string {
  switch (status) {
    case "success":
      return "text-green-800";
    case "error":
      return "text-red-800";
    default:
      return "text-gray-700";
  }
}

/**
 * Get combined badge classes based on request status
 */
export function getStatusBadgeClasses(status: RequestStatus): string {
  const bg = getStatusBackgroundClass(status);
  const border = getStatusBorderClass(status);
  const text = getStatusTextClass(status);
  return `${bg} ${border} ${text}`;
}

/**
 * Get stats item for a provider:model (aggregate, excludes per-key entries)
 */
export function getRequestStatsItem(
  requestStats: RequestStatsItem[] | undefined,
  provider: string,
  model: string
): RequestStatsItem | undefined {
  return requestStats?.find(
    (s) => s.provider === provider && s.model === model && s.keyIndex === undefined
  );
}

/**
 * Get per-key stats item for a specific provider:keyIndex:model
 */
export function getKeyRequestStatsItem(
  requestStats: RequestStatsItem[] | undefined,
  provider: string,
  keyIndex: number,
  model: string
): RequestStatsItem | undefined {
  return requestStats?.find(
    (s) => s.provider === provider && s.model === model && s.keyIndex === keyIndex
  );
}

/**
 * Get all per-key stats for a provider (across all models and keys)
 */
export function getProviderKeyStats(
  requestStats: RequestStatsItem[] | undefined,
  provider: string
): RequestStatsItem[] {
  if (!requestStats) return [];
  return requestStats.filter(
    (s) => s.provider === provider && s.keyIndex !== undefined
  );
}
