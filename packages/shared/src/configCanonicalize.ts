function canonicalizeProvider(provider: any) {
  if (!provider || typeof provider !== "object") {
    return provider;
  }

  const nextProvider = { ...provider };
  delete nextProvider.models;
  return nextProvider;
}

export function canonicalizeExternalConfig(config: any) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }

  const nextConfig = { ...config };
  const rawProviders = Array.isArray(nextConfig.Providers)
    ? nextConfig.Providers
    : Array.isArray(nextConfig.providers)
      ? nextConfig.providers
      : [];

  nextConfig.Providers = rawProviders.map(canonicalizeProvider);
  delete nextConfig.providers;

  return nextConfig;
}
