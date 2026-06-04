import { ConfigService } from "@musistudio/llms";

declare module "@musistudio/llms" {
  export interface ConfigService {
    validateConfig(jsonContent: string): ConfigValidationResult;
    reloadWithValidation(): Promise<ConfigValidationResult>;
    scheduleReload(): void;
    onConfigChange(listener: ConfigChangeListener): () => void;
    onConfigError(listener: ConfigErrorListener): () => void;
  }

  export interface ConfigValidationResult {
    valid: boolean;
    config?: AppConfig;
    error?: string;
  }

  export type ConfigChangeListener = (newConfig: AppConfig) => void;
  export type ConfigErrorListener = (error: Error, oldConfig: AppConfig) => void;
}