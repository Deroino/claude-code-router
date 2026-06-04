import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config } from "dotenv";
import JSON5 from 'json5';
import { EventEmitter } from 'events';
import { canonicalizeExternalConfig } from "@CCR/shared";
import {
  isGroupReference,
  parseGroupReference,
  parseProviderModel,
  ROUTER_MODEL_FIELDS,
} from "../types/llm";
import type { ModelGroup, RouterConfig, RouterModelField } from "../types/llm";

const GROUP_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface ConfigOptions {
  envPath?: string;
  jsonPath?: string;
  useEnvFile?: boolean;
  useJsonFile?: boolean;
  useEnvironmentVariables?: boolean;
  initialConfig?: AppConfig;
}

export interface AppConfig {
  [key: string]: any;
}

export interface ConfigValidationResult {
  valid: boolean;
  config?: AppConfig;
  error?: string;
}

export type ConfigChangeListener = (newConfig: AppConfig) => void;
export type ConfigErrorListener = (error: Error, oldConfig: AppConfig) => void;

function getProviderModelsFromApiKeys(provider: any): string[] {
  if (!provider || !Array.isArray(provider.api_key)) {
    return [];
  }

  const models = new Set<string>();
  provider.api_key.forEach((entry: any) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Array.isArray(entry.models)) {
      entry.models.filter(Boolean).forEach((model: string) => models.add(model));
    }
  });

  return Array.from(models);
}

function providerModelExists(providers: any[], value: string): boolean {
  const parsed = parseProviderModel(value);
  if (!parsed) {
    return false;
  }

  const provider = providers.find((item) => item?.name === parsed.provider);
  return !!provider && getProviderModelsFromApiKeys(provider).includes(parsed.model);
}

function validateModelRouteValue(
  value: unknown,
  field: RouterModelField,
  providers: any[],
  groupNames: Set<string>
): string | null {
  if (value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    return `Router.${field} must be a string`;
  }

  if (isGroupReference(value)) {
    const groupName = parseGroupReference(value);
    if (!groupName || !groupNames.has(groupName)) {
      return `Router.${field} references unknown ModelGroup '${groupName || value}'`;
    }
    return null;
  }

  if (!parseProviderModel(value)) {
    return `Router.${field} must be a valid provider,model or group:<name> value`;
  }

  if (!providerModelExists(providers, value)) {
    return `Router.${field} references unknown model '${value}'`;
  }

  return null;
}

function validateConfigSemantics(parsed: AppConfig): string | null {
  const normalized = canonicalizeExternalConfig(parsed) as AppConfig;
  const providers = Array.isArray(normalized.Providers)
    ? normalized.Providers
    : [];

  const modelGroups = parsed.ModelGroups;
  const groupNames = new Set<string>();

  if (modelGroups !== undefined) {
    if (!Array.isArray(modelGroups)) {
      return "ModelGroups must be an array";
    }

    for (let index = 0; index < modelGroups.length; index++) {
      const group = modelGroups[index] as ModelGroup;
      if (!group || typeof group !== "object") {
        return `ModelGroups[${index}] must be an object`;
      }

      if (typeof group.name !== "string" || !group.name.trim()) {
        return `ModelGroups[${index}].name is required`;
      }

      if (!GROUP_NAME_REGEX.test(group.name)) {
        return `ModelGroups[${index}].name must match ${GROUP_NAME_REGEX}`;
      }

      if (groupNames.has(group.name)) {
        return `ModelGroups contains duplicate name '${group.name}'`;
      }
      groupNames.add(group.name);

      if (!Array.isArray(group.models) || group.models.length === 0) {
        return `ModelGroups[${index}].models must be a non-empty array`;
      }

      for (let modelIndex = 0; modelIndex < group.models.length; modelIndex++) {
        const member = group.models[modelIndex];
        if (typeof member !== "string" || !parseProviderModel(member)) {
          return `ModelGroups[${index}].models[${modelIndex}] must be in provider,model format`;
        }

        if (!providerModelExists(providers, member)) {
          return `ModelGroups[${index}].models[${modelIndex}] references unknown model '${member}'`;
        }
      }
    }
  }

  const router = parsed.Router as RouterConfig | undefined;
  if (router !== undefined) {
    if (typeof router !== "object" || router === null) {
      return "Router must be an object";
    }

    for (const field of ROUTER_MODEL_FIELDS) {
      const validationError = validateModelRouteValue(router[field], field, providers, groupNames);
      if (validationError) {
        return validationError;
      }
    }
  }

  return null;
}

export class ConfigService extends EventEmitter {
  private config: AppConfig = {};
  private options: ConfigOptions;
  private reloadTimer: NodeJS.Timeout | null = null;
  private readonly RELOAD_DEBOUNCE_MS = 500;

  constructor(
    options: ConfigOptions = {
      jsonPath: "./config.json",
    }
  ) {
    super();
    this.options = {
      envPath: options.envPath || ".env",
      jsonPath: options.jsonPath,
      useEnvFile: false,
      useJsonFile: options.useJsonFile !== false,
      useEnvironmentVariables: options.useEnvironmentVariables !== false,
      ...options,
    };

    this.loadConfig();
  }

  private loadConfig(): void {
    if (this.options.useJsonFile && this.options.jsonPath) {
      this.loadJsonConfig();
    }

    if (this.options.initialConfig) {
      this.config = { ...this.config, ...this.options.initialConfig };
    }

    if (this.options.useEnvFile) {
      this.loadEnvConfig();
    }

    if (this.config.LOG_FILE) {
      process.env.LOG_FILE = this.config.LOG_FILE;
    }
    if (this.config.LOG !== undefined) {
      process.env.LOG = String(this.config.LOG);
    }
  }

  private loadJsonConfig(): void {
    if (!this.options.jsonPath) return;

    const jsonPath = this.isAbsolutePath(this.options.jsonPath)
      ? this.options.jsonPath
      : join(process.cwd(), this.options.jsonPath);

    if (existsSync(jsonPath)) {
      try {
        const jsonContent = readFileSync(jsonPath, "utf-8");
        const jsonConfig = JSON5.parse(jsonContent);
        this.config = { ...this.config, ...jsonConfig };
        console.log(`Loaded JSON config from: ${jsonPath}`);
      } catch (error) {
        console.warn(`Failed to load JSON config from ${jsonPath}:`, error);
      }
    } else {
      console.warn(`JSON config file not found: ${jsonPath}`);
    }
  }

  private loadEnvConfig(): void {
    const envPath = this.isAbsolutePath(this.options.envPath!)
      ? this.options.envPath!
      : join(process.cwd(), this.options.envPath!);

    if (existsSync(envPath)) {
      try {
        const result = config({ path: envPath });
        if (result.parsed) {
          this.config = {
            ...this.config,
            ...this.parseEnvConfig(result.parsed),
          };
        }
      } catch (error) {
        console.warn(`Failed to load .env config from ${envPath}:`, error);
      }
    }
  }

  private loadEnvironmentVariables(): void {
    const envConfig = this.parseEnvConfig(process.env);
    this.config = { ...this.config, ...envConfig };
  }

  private parseEnvConfig(
    env: Record<string, string | undefined>
  ): Partial<AppConfig> {
    const parsed: Partial<AppConfig> = {};

    Object.assign(parsed, env);

    return parsed;
  }

  private isAbsolutePath(path: string): boolean {
    return path.startsWith("/") || path.includes(":");
  }

  public get<T = any>(key: keyof AppConfig): T | undefined;
  public get<T = any>(key: keyof AppConfig, defaultValue: T): T;
  public get<T = any>(key: keyof AppConfig, defaultValue?: T): T | undefined {
    const value = this.config[key];
    return value !== undefined ? (value as T) : defaultValue;
  }

  public getAll(): AppConfig {
    return { ...this.config };
  }

  public getHttpsProxy(): string | undefined {
    return (
      this.get("HTTPS_PROXY") ||
      this.get("https_proxy") ||
      this.get("httpsProxy") ||
      this.get("PROXY_URL")
    );
  }

  public has(key: keyof AppConfig): boolean {
    return this.config[key] !== undefined;
  }

  public set(key: keyof AppConfig, value: any): void {
    this.config[key] = value;
  }

  public reload(): void {
    this.config = {};
    this.loadConfig();
  }

  /**
   * Validate configuration from JSON string
   */
  public validateConfig(jsonContent: string): ConfigValidationResult {
    try {
      const parsed = JSON5.parse(jsonContent);

      if (typeof parsed !== 'object' || parsed === null) {
        return {
          valid: false,
          error: 'Config must be a valid object'
        };
      }

      const normalized = canonicalizeExternalConfig(parsed as AppConfig) as AppConfig;
      const semanticError = validateConfigSemantics(normalized);
      if (semanticError) {
        return {
          valid: false,
          error: semanticError,
        };
      }

      return {
        valid: true,
        config: normalized
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown parsing error'
      };
    }
  }

  /**
   * Reload configuration with validation
   * Only applies new config if validation passes
   */
  public async reloadWithValidation(): Promise<ConfigValidationResult> {
    const oldConfig = { ...this.config };

    if (!this.options.jsonPath) {
      return {
        valid: false,
        error: 'No JSON path configured'
      };
    }

    const jsonPath = this.isAbsolutePath(this.options.jsonPath)
      ? this.options.jsonPath
      : join(process.cwd(), this.options.jsonPath);

    if (!existsSync(jsonPath)) {
      return {
        valid: false,
        error: `Config file not found: ${jsonPath}`
      };
    }

    try {
      const jsonContent = readFileSync(jsonPath, 'utf-8');
      const validationResult = this.validateConfig(jsonContent);

      if (!validationResult.valid || !validationResult.config) {
        const error = new Error(validationResult.error || 'Validation failed');
        this.emit('configError', error, oldConfig);
        return validationResult;
      }

      this.config = {};

      if (this.options.initialConfig) {
        this.config = { ...this.config, ...this.options.initialConfig };
      }

      this.config = { ...this.config, ...validationResult.config };

      if (this.options.useEnvFile) {
        this.loadEnvConfig();
      }

      if (this.config.LOG_FILE) {
        process.env.LOG_FILE = this.config.LOG_FILE;
      }
      if (this.config.LOG !== undefined) {
        process.env.LOG = String(this.config.LOG);
      }

      this.emit('configChange', { ...this.config });

      return {
        valid: true,
        config: { ...this.config }
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('configError', err, oldConfig);
      return {
        valid: false,
        error: err.message
      };
    }
  }

  /**
   * Schedule a reload with debouncing (500ms delay)
   */
  public scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(async () => {
      const result = await this.reloadWithValidation();
      if (result.valid) {
        console.log('Config reloaded successfully via scheduleReload');
      } else {
        console.error('Config reload failed via scheduleReload:', result.error);
      }
    }, this.RELOAD_DEBOUNCE_MS);
  }

  /**
   * Subscribe to config change events
   * Returns an unsubscribe function
   */
  public onConfigChange(listener: ConfigChangeListener): () => void {
    this.on('configChange', listener as any);
    return () => this.off('configChange', listener as any);
  }

  /**
   * Subscribe to config error events
   * Returns an unsubscribe function
   */
  public onConfigError(listener: ConfigErrorListener): () => void {
    this.on('configError', listener as any);
    return () => this.off('configError', listener as any);
  }

  public getConfigSummary(): string {
    const summary: string[] = [];

    if (this.options.initialConfig) {
      summary.push("Initial Config");
    }

    if (this.options.useJsonFile && this.options.jsonPath) {
      summary.push(`JSON: ${this.options.jsonPath}`);
    }

    if (this.options.useEnvFile) {
      summary.push(`ENV: ${this.options.envPath}`);
    }

    if (this.options.useEnvironmentVariables) {
      summary.push("Environment Variables");
    }

    return `Config sources: ${summary.join(", ")}`;
  }
}
