export interface ProviderTransformer {
  use: (string | (string | Record<string, unknown> | { max_tokens: number })[])[];
  [key: string]: any; // Allow for model-specific transformers
}

// Structured API key entry with optional explicit model assignment
export interface ApiKeyEntry {
  key: string;
  models?: string[];  // If omitted, supports all provider models
  group?: string;     // NewAPI group name (UI metadata, resolved to models on assignment)
}

// API key configuration: single string, array of strings, or mixed array with objects
export type ApiKeyConfig = string | (string | ApiKeyEntry)[];

export interface Provider {
  name: string;
  api_base_url: string;
  api_key: ApiKeyConfig;
  models: string[];
  transformer?: ProviderTransformer;
}

export const ROUTER_MODEL_FIELDS = [
  'default',
  'background',
  'think',
  'longContext',
  'webSearch',
  'image',
  'compact',
] as const;

export type RouterModelField = typeof ROUTER_MODEL_FIELDS[number];

export interface RouterConfig {
    default: string;
    background: string;
    think: string;
    longContext: string;
    longContextThreshold: number;
    webSearch: string;
    image: string;
    compact?: string;
    custom?: any;
}

export interface Transformer {
    name?: string;
    path: string;
    options?: Record<string, any>;
}

export interface ModelGroup {
  name: string;
  models: string[]; // Each item is "providerName,modelName" format
}

export interface StatusLineModuleConfig {
  type: string;
  icon?: string;
  text: string;
  color?: string;
  background?: string;
  scriptPath?: string; // 用于script类型的模块，指定要执行的Node.js脚本文件路径
}

export interface StatusLineThemeConfig {
  modules: StatusLineModuleConfig[];
}

export interface StatusLineConfig {
  enabled: boolean;
  currentStyle: string;
  default: StatusLineThemeConfig;
  powerline: StatusLineThemeConfig;
  fontFamily?: string;
}

export interface Config {
  Providers: Provider[];
  Router: RouterConfig;
  transformers: Transformer[];
  ModelGroups?: ModelGroup[];
  StatusLine?: StatusLineConfig;
  forceUseImageAgent?: boolean;
  noAuth?: boolean;
  // Top-level settings
  LOG: boolean;
  LOG_LEVEL: string;
  CLAUDE_PATH: string;
  HOST: string;
  PORT: number;
  APIKEY: string;
  API_TIMEOUT_MS: string;
  PROXY_URL: string;
  CUSTOM_ROUTER_PATH?: string;
  TEST_PROMPT?: string;
}

export type AccessLevel = 'restricted' | 'full';
