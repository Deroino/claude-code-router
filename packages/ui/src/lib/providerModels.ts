import type { ApiKeyConfig, Provider } from "@/types";

export function getProviderModelUnionFromApiKey(apiKey: ApiKeyConfig): string[] {
  if (!Array.isArray(apiKey)) {
    return [];
  }

  const union = new Set<string>();
  apiKey.forEach((entry) => {
    if (typeof entry !== "string" && entry?.models) {
      entry.models.forEach((model: string) => union.add(model));
    }
  });

  return Array.from(union);
}

export function getProviderModelUnion(provider: Pick<Provider, "api_key">): string[] {
  return getProviderModelUnionFromApiKey(provider.api_key);
}
