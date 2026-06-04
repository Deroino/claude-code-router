import type { BatchTestResult } from "@/components/BatchTestDialog";
import type { ModelGroup, Provider, RouterConfig } from "@/types";
import { getProviderModelUnion } from "@/lib/providerModels";
import { isGroupReference, parseGroupReference } from "@/lib/modelOptions";

export interface BatchTestTarget {
  provider: string;
  model: string;
  keyIndex?: number;
}

export function getBatchTestResultKey(result: BatchTestTarget): string {
  return result.keyIndex !== undefined
    ? `${result.provider}-${result.model}-key${result.keyIndex}`
    : `${result.provider}-${result.model}`;
}

export function mergeBatchTestResults(
  prev: BatchTestResult[],
  incoming: BatchTestResult[]
): BatchTestResult[] {
  const incomingMap = new Map(incoming.map(result => [getBatchTestResultKey(result), result]));
  const merged = prev.map(result => incomingMap.get(getBatchTestResultKey(result)) || result);
  const existingKeys = new Set(prev.map(result => getBatchTestResultKey(result)));
  const appended = incoming.filter(result => !existingKeys.has(getBatchTestResultKey(result)));
  return [...merged, ...appended];
}

export function markBatchTestsAsTesting(
  prev: BatchTestResult[],
  selectedTests: BatchTestResult[]
): BatchTestResult[] {
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
}

export function mergePersistedBatchTests(
  allTests: BatchTestTarget[],
  persistedResults: BatchTestResult[]
): BatchTestResult[] {
  const persistedMap = new Map<string, BatchTestResult>();
  for (const result of persistedResults) {
    persistedMap.set(getBatchTestResultKey(result), result);
  }
  return allTests.map(({ provider, model, keyIndex }) => {
    const key = getBatchTestResultKey({ provider, model, keyIndex });
    return persistedMap.get(key) || {
      provider,
      model,
      ...(keyIndex !== undefined ? { keyIndex } : {}),
      status: "idle" as const,
    };
  });
}

export function buildFreshBatchTests(allTests: BatchTestTarget[]): BatchTestResult[] {
  return allTests.map(({ provider, model, keyIndex }) => ({
    provider,
    model,
    ...(keyIndex !== undefined ? { keyIndex } : {}),
    status: "idle" as const,
  }));
}

export function filterRemovedBatchTestResult(
  results: BatchTestResult[],
  provider: string,
  model: string
): BatchTestResult[] {
  return results.filter(result => !(result.provider === provider && result.model === model));
}

export function filterRemovedBatchTestResults(
  results: BatchTestResult[],
  provider: string,
  models: string[]
): BatchTestResult[] {
  const removedModelSet = new Set(models);
  return results.filter(result => !(result.provider === provider && removedModelSet.has(result.model)));
}

export function filterProviderBatchTestResults(
  results: BatchTestResult[],
  provider: string
): BatchTestResult[] {
  return results.filter(result => result.provider !== provider);
}

export function buildBatchTestsForProvider(provider: Provider | undefined): BatchTestTarget[] {
  if (!provider?.name) return [];

  const providerModels = getProviderModelUnion(provider);
  if (providerModels.length === 0) return [];

  const rawKeys = Array.isArray(provider.api_key) ? provider.api_key : [provider.api_key];
  const hasPerKeyModels = rawKeys.some(
    entry => typeof entry !== "string" && entry?.models && entry.models.length > 0
  );

  if (hasPerKeyModels && rawKeys.length > 1) {
    return rawKeys.flatMap((entry, keyIndex) => {
      const keyModels = typeof entry !== "string" && entry?.models && entry.models.length > 0
        ? entry.models
        : providerModels;
      return keyModels.map(model => ({
        provider: provider.name,
        model,
        keyIndex,
      }));
    });
  }

  return providerModels.map(model => ({
    provider: provider.name,
    model,
  }));
}

export function buildBatchTestsForProviders(providers: Provider[]): BatchTestTarget[] {
  return providers.flatMap(buildBatchTestsForProvider);
}

export function buildBatchTestsForModelValues(
  values: string[],
  providers: Provider[],
  groups: ModelGroup[] = []
): BatchTestTarget[] {
  const providerMap = new Map(providers.map(provider => [provider.name, provider]));
  const groupMap = new Map(groups.map(group => [group.name, group]));
  const tests = new Map<string, BatchTestTarget>();

  const addValue = (value: string) => {
    if (!value) return;

    if (isGroupReference(value)) {
      const groupName = parseGroupReference(value);
      const group = groupName ? groupMap.get(groupName) : undefined;
      group?.models?.forEach(addValue);
      return;
    }

    const [providerName, ...modelParts] = value.split(",");
    const model = modelParts.join(",");
    if (!providerName || !model) return;

    const provider = providerMap.get(providerName);
    if (!provider) return;

    const providerTests = buildBatchTestsForProvider(provider);
    const matchingTests = providerTests.filter(test => test.model === model);
    const targets = matchingTests.length > 0 ? matchingTests : [{ provider: providerName, model }];

    for (const target of targets) {
      tests.set(getBatchTestResultKey(target), target);
    }
  };

  values.forEach(addValue);
  return Array.from(tests.values());
}

export function getSelectedRouterModelValues(router: RouterConfig | undefined): string[] {
  if (!router) return [];

  return [
    router.default,
    router.background,
    router.think,
    router.longContext,
    router.webSearch,
    router.image,
    router.compact,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}
