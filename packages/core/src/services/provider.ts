import { TransformerConstructor } from "@/types/transformer";
import {
  LLMProvider,
  RegisterProviderRequest,
  ModelRoute,
  RequestRouteInfo,
  ConfigProvider,
  ApiKeyConfig,
  ApiKeyEntry,
  ResolvedApiKey,
} from "../types/llm";
import { ConfigService } from "./config";
import { TransformerService } from "./transformer";
import type { RequestStatsService } from "./requestStats";

// Normalized internal representation of an API key entry
interface NormalizedKeyEntry {
  key: string;
  index: number;
  models: string[] | null;  // null = supports all provider models
}

export class ProviderService {
  private providers: Map<string, LLMProvider> = new Map();
  private modelRoutes: Map<string, ModelRoute> = new Map();
  // Track rotation index for round-robin API key selection (keyed by providerName:model)
  private apiKeyRotationIndex: Map<string, number> = new Map();
  // Optional stats service for health-aware key selection
  private statsService: RequestStatsService | null = null;

  constructor(private readonly configService: ConfigService, private readonly transformerService: TransformerService, private readonly logger: any) {
    this.initializeCustomProviders();
  }

  /**
   * Set the RequestStatsService for health-aware API key selection.
   * Separated from constructor to avoid circular dependency and esbuild dual-singleton issues.
   */
  setStatsService(statsService: RequestStatsService): void {
    this.statsService = statsService;
  }

  private initializeCustomProviders() {
    const providersConfig =
      this.configService.get<ConfigProvider[]>("providers") || this.configService.get<ConfigProvider[]>("Providers");
    if (providersConfig && Array.isArray(providersConfig)) {
      this.initializeFromProvidersArray(providersConfig);
      return;
    }
  }

  /**
   * Reload providers from current config.
   * Clears existing providers/routes and re-initializes from ConfigService.
   * apiKeyRotationIndex is intentionally preserved for rotation continuity.
   * Safe in single-threaded JS: no request can interleave during synchronous execution.
   */
  public reload(): void {
    this.providers.clear();
    this.modelRoutes.clear();
    // NOTE: apiKeyRotationIndex intentionally preserved
    this.initializeCustomProviders();
    this.logger.info(`Provider reload complete. ${this.providers.size} providers active.`);
  }

  private initializeFromProvidersArray(providersConfig: ConfigProvider[]) {
    providersConfig.forEach((providerConfig: ConfigProvider) => {
      try {
        // Support array of API keys (string, object, or mixed) - validate at least one key exists
        const hasValidKey = Array.isArray(providerConfig.api_key)
          ? providerConfig.api_key.some(k =>
              typeof k === 'string' ? !!k : (k && typeof k === 'object' && !!k.key)
            )
          : !!providerConfig.api_key;

        if (
          !providerConfig.name ||
          !providerConfig.api_base_url ||
          !hasValidKey
        ) {
          return;
        }

        const transformer: LLMProvider["transformer"] = {}

        if (providerConfig.transformer) {
          Object.keys(providerConfig.transformer).forEach(key => {
            if (key === 'use') {
              if (Array.isArray(providerConfig.transformer.use)) {
                transformer.use = providerConfig.transformer.use.map((transformer) => {
                  if (Array.isArray(transformer) && typeof transformer[0] === 'string') {
                    const Constructor = this.transformerService.getTransformer(transformer[0]);
                    if (Constructor) {
                      return new (Constructor as TransformerConstructor)(transformer[1]);
                    }
                  }
                  if (typeof transformer === 'string') {
                    const transformerInstance = this.transformerService.getTransformer(transformer);
                    if (typeof transformerInstance === 'function') {
                      return new transformerInstance();
                    }
                    return transformerInstance;
                  }
                }).filter((transformer) => typeof transformer !== 'undefined');
              }
            } else {
              if (Array.isArray(providerConfig.transformer[key]?.use)) {
                transformer[key] = {
                  use: providerConfig.transformer[key].use.map((transformer) => {
                    if (Array.isArray(transformer) && typeof transformer[0] === 'string') {
                      const Constructor = this.transformerService.getTransformer(transformer[0]);
                      if (Constructor) {
                        return new (Constructor as TransformerConstructor)(transformer[1]);
                      }
                    }
                    if (typeof transformer === 'string') {
                      const transformerInstance = this.transformerService.getTransformer(transformer);
                      if (typeof transformerInstance === 'function') {
                        return new transformerInstance();
                      }
                      return transformerInstance;
                    }
                  }).filter((transformer) => typeof transformer !== 'undefined')
                }
              }
            }
          })
        }

        this.registerProvider({
          name: providerConfig.name,
          baseUrl: providerConfig.api_base_url,
          apiKey: providerConfig.api_key,
          models: providerConfig.models || [],
          transformer: providerConfig.transformer ? transformer : undefined,
        });

        this.logger.info(`${providerConfig.name} provider registered`);
      } catch (error) {
        this.logger.error(`${providerConfig.name} provider registered error: ${error}`);
      }
    });
  }

  registerProvider(request: RegisterProviderRequest): LLMProvider {
    const provider: LLMProvider = {
      ...request,
    };

    this.providers.set(provider.name, provider);

    request.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      const route: ModelRoute = {
        provider: provider.name,
        model,
        fullModel,
      };
      this.modelRoutes.set(fullModel, route);
      if (!this.modelRoutes.has(model)) {
        this.modelRoutes.set(model, route);
      }
    });

    return provider;
  }

  getProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  updateProvider(
    id: string,
    updates: Partial<LLMProvider>
  ): LLMProvider | null {
    const provider = this.providers.get(id);
    if (!provider) {
      return null;
    }

    const updatedProvider = {
      ...provider,
      ...updates,
      updatedAt: new Date(),
    };

    this.providers.set(id, updatedProvider);

    if (updates.models) {
      provider.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        this.modelRoutes.delete(fullModel);
        this.modelRoutes.delete(model);
      });

      updates.models.forEach((model) => {
        const fullModel = `${provider.name},${model}`;
        const route: ModelRoute = {
          provider: provider.name,
          model,
          fullModel,
        };
        this.modelRoutes.set(fullModel, route);
        if (!this.modelRoutes.has(model)) {
          this.modelRoutes.set(model, route);
        }
      });
    }

    return updatedProvider;
  }

  deleteProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) {
      return false;
    }

    provider.models.forEach((model) => {
      const fullModel = `${provider.name},${model}`;
      this.modelRoutes.delete(fullModel);
      this.modelRoutes.delete(model);
    });

    this.providers.delete(id);
    return true;
  }

  toggleProvider(name: string, enabled: boolean): boolean {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }
    return true;
  }

  resolveModelRoute(modelName: string): RequestRouteInfo | null {
    const route = this.modelRoutes.get(modelName);
    if (!route) {
      return null;
    }

    const provider = this.providers.get(route.provider);
    if (!provider) {
      return null;
    }

    return {
      provider,
      originalModel: modelName,
      targetModel: route.model,
    };
  }

  getAvailableModelNames(): string[] {
    const modelNames: string[] = [];
    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        modelNames.push(model);
        modelNames.push(`${provider.name},${model}`);
      });
    });
    return modelNames;
  }

  getModelRoutes(): ModelRoute[] {
    return Array.from(this.modelRoutes.values());
  }

  /**
   * Get API key with round-robin rotation, model filtering, and health-aware selection.
   *
   * Selection logic:
   * 1. Normalize all keys to uniform entries
   * 2. Filter by target model (only keys whose models include the target)
   * 3. Filter by health status (skip keys with consecutive recent failures)
   * 4. Round-robin among remaining eligible keys
   * 5. Fallback: if all unhealthy, use all model-eligible keys
   */
  getApiKey(providerName: string, apiKey: ApiKeyConfig, targetModel?: string, providerModels?: string[]): ResolvedApiKey {
    // Single string key - no rotation needed
    if (typeof apiKey === 'string') {
      return { key: apiKey, keyIndex: 0 };
    }

    // Normalize all entries to uniform format
    const entries = this.normalizeApiKeys(apiKey, providerModels || []);

    if (entries.length === 0) {
      // Should not happen with valid config, but safety fallback
      this.logger.warn(`No valid API keys found for provider ${providerName}`);
      return { key: '', keyIndex: 0 };
    }

    // Step 1: Filter by model support
    let eligible = entries;
    if (targetModel) {
      const modelFiltered = entries.filter(
        e => e.models === null || e.models.includes(targetModel)
      );
      if (modelFiltered.length > 0) {
        eligible = modelFiltered;
      } else {
        // No key explicitly supports this model - use all keys as fallback
        this.logger.warn(
          `No API key in provider ${providerName} explicitly supports model ${targetModel}, using all keys`
        );
      }
    }

    // Step 2: Filter by health status
    let healthy = eligible;
    if (this.statsService && targetModel) {
      healthy = eligible.filter(e => this.isKeyHealthy(providerName, e.index, targetModel));
      if (healthy.length === 0) {
        // All keys unhealthy - fall back to all eligible keys (don't completely block)
        this.logger.warn(
          `All API keys for ${providerName}/${targetModel} are unhealthy, using all eligible keys`
        );
        healthy = eligible;
      }
    }

    // Step 3: Round-robin among healthy eligible keys
    const rotationKey = `${providerName}:${targetModel || '*'}`;
    let index = this.apiKeyRotationIndex.get(rotationKey) || 0;
    const selected = healthy[index % healthy.length];

    // Increment index for next request
    this.apiKeyRotationIndex.set(rotationKey, index + 1);

    return { key: selected.key, keyIndex: selected.index };
  }

  /**
   * Normalize mixed ApiKeyConfig to uniform NormalizedKeyEntry array.
   * Handles: string[], (string | ApiKeyEntry)[]
   */
  private normalizeApiKeys(apiKey: (string | ApiKeyEntry)[], providerModels: string[]): NormalizedKeyEntry[] {
    return apiKey
      .map((entry, idx): NormalizedKeyEntry | null => {
        if (typeof entry === 'string') {
          if (!entry) return null;
          return { key: entry, index: idx, models: null };
        }
        if (entry && typeof entry === 'object' && entry.key) {
          return {
            key: entry.key,
            index: idx,
            models: entry.models && entry.models.length > 0 ? entry.models : null,
          };
        }
        return null;
      })
      .filter((e): e is NormalizedKeyEntry => e !== null);
  }

  /**
   * Check if a key is considered healthy for a given model.
   * A key is unhealthy if:
   * - It has more than 3 consecutive failures (fail > success means mostly failing)
   * - Its last failure was within the last 5 minutes
   * - It has no successful requests at all (fail-only)
   */
  private isKeyHealthy(providerName: string, keyIndex: number, model: string): boolean {
    if (!this.statsService) return true;

    const stats = this.statsService.getKeyStats(providerName, keyIndex, model);
    if (!stats) return true;  // No stats = never used = healthy

    // If there have been no failures, it's healthy
    if (stats.fail === 0) return true;

    // If there have been successes recently, check if the last success is more recent than last failure
    if (stats.lastSuccessRequest && stats.lastFailureRequest) {
      const lastSuccess = new Date(stats.lastSuccessRequest.timestamp).getTime();
      const lastFailure = new Date(stats.lastFailureRequest.timestamp).getTime();
      // Last success is more recent - key has recovered
      if (lastSuccess > lastFailure) return true;
    }

    // Check if last failure is within the 5-minute window
    if (stats.lastFailureRequest) {
      const lastFailureTime = new Date(stats.lastFailureRequest.timestamp).getTime();
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      if (lastFailureTime < fiveMinutesAgo) return true;  // Old failure, consider recovered
    }

    // Key has recent failures and no recent success - check fail threshold
    // Consider unhealthy if fail count exceeds 3 and there are more failures than successes
    if (stats.fail >= 3 && stats.fail > stats.success) {
      return false;
    }

    return true;
  }

  private parseTransformerConfig(transformerConfig: any): any {
    if (!transformerConfig) return {};

    if (Array.isArray(transformerConfig)) {
      return transformerConfig.reduce((acc, item) => {
        if (Array.isArray(item)) {
          const [name, config = {}] = item;
          acc[name] = config;
        } else {
          acc[item] = {};
        }
        return acc;
      }, {});
    }

    return transformerConfig;
  }

  async getAvailableModels(): Promise<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }>;
  }> {
    const models: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }> = [];

    this.providers.forEach((provider) => {
      provider.models.forEach((model) => {
        models.push({
          id: model,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });

        models.push({
          id: `${provider.name},${model}`,
          object: "model",
          owned_by: provider.name,
          provider: provider.name,
        });
      });
    });

    return {
      object: "list",
      data: models,
    };
  }
}
