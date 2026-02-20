/**
 * Request Statistics Service
 * Tracks success/failure counts for API requests by provider:model dimension
 * Only stores the last request/response to prevent memory bloat
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface LastRequestInfo {
  timestamp: string;
  request: any;
}

export interface LastSuccessInfo extends LastRequestInfo {
  response: any;
}

export interface LastFailureInfo extends LastRequestInfo {
  error: string;
  statusCode?: number;
}

export interface RequestStats {
  success: number;
  fail: number;
  lastSuccessRequest?: LastSuccessInfo;
  lastFailureRequest?: LastFailureInfo;
  /** @deprecated Use lastSuccessRequest or lastFailureRequest */
  lastRequest?: LastSuccessInfo | LastFailureInfo;
}

// Well-known default stats file path
const DEFAULT_STATS_FILE = join(homedir(), '.claude-code-router', 'request-stats.json');

export class RequestStatsService extends EventEmitter {
  private stats: Map<string, RequestStats> = new Map();
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty: boolean = false;
  private statsFilePath: string = '';

  constructor() {
    super();
  }

  getStats(provider: string, model: string): RequestStats | undefined {
    const key = this.buildKey(provider, model);
    return this.stats.get(key);
  }

  getAllStats(): Map<string, RequestStats> {
    return new Map(this.stats);
  }

  /**
   * Ensure persistence is initialized before recording data.
   * Uses the well-known default path if initPersistence() was never called.
   * This prevents data loss from esbuild dual-singleton issues where
   * initPersistence() is called on one instance but data is recorded on another.
   */
  private ensurePersistence(): void {
    if (this.persistTimer) return;
    this.initPersistence(this.statsFilePath || DEFAULT_STATS_FILE);
  }

  recordSuccess(provider: string, model: string, request: any, response: any): void {
    this.ensurePersistence();
    const key = this.buildKey(provider, model);
    const existing = this.stats.get(key) || { success: 0, fail: 0 };
    const lastSuccessRequest: LastSuccessInfo = {
      timestamp: new Date().toISOString(), request, response
    };
    const newStats: RequestStats = {
      success: existing.success + 1,
      fail: existing.fail,
      lastSuccessRequest,
      lastFailureRequest: existing.lastFailureRequest,
      lastRequest: lastSuccessRequest // backward compat
    };
    this.stats.set(key, newStats);
    this.dirty = true;
    this.emit('stats_update', { key, stats: newStats });
  }

  recordFailure(provider: string, model: string, request: any, error: string, statusCode?: number): void {
    this.ensurePersistence();
    const key = this.buildKey(provider, model);
    const existing = this.stats.get(key) || { success: 0, fail: 0 };
    const lastFailureRequest: LastFailureInfo = {
      timestamp: new Date().toISOString(), request, error, statusCode
    };
    const newStats: RequestStats = {
      success: existing.success,
      fail: existing.fail + 1,
      lastSuccessRequest: existing.lastSuccessRequest,
      lastFailureRequest,
      lastRequest: lastFailureRequest // backward compat
    };
    this.stats.set(key, newStats);
    this.dirty = true;
    this.emit('stats_update', { key, stats: newStats });
  }

  clearAll(): void {
    this.stats.clear();
    this.dirty = true;
    this.saveToFile(); // immediate save on clear
    this.emit('stats_clear');
  }

  /**
   * Initialize persistence with a file path
   * Call this after construction with the STATS_FILE path
   */
  initPersistence(filePath: string): void {
    // Prevent double initialization
    if (this.persistTimer) return;
    this.statsFilePath = filePath;
    this.loadFromFile();
    // Sync to file every 30 seconds if dirty
    this.persistTimer = setInterval(() => {
      if (this.dirty) {
        this.saveToFile();
      }
    }, 30000);
  }

  private loadFromFile(): void {
    if (!this.statsFilePath) return;
    try {
      if (existsSync(this.statsFilePath)) {
        const content = readFileSync(this.statsFilePath, 'utf-8');
        const data = JSON.parse(content);
        // Restore from plain object to Map
        if (data && typeof data === 'object') {
          for (const [key, value] of Object.entries(data)) {
            this.stats.set(key, value as RequestStats);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load request stats from file:', error);
    }
  }

  private saveToFile(): void {
    if (!this.statsFilePath) return;
    try {
      const dir = dirname(this.statsFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Convert Map to plain object, preserve all fields
      const data: Record<string, any> = {};
      this.stats.forEach((value, key) => {
        data[key] = {
          success: value.success,
          fail: value.fail,
          lastSuccessRequest: value.lastSuccessRequest ? {
            timestamp: value.lastSuccessRequest.timestamp,
            request: value.lastSuccessRequest.request,
            response: value.lastSuccessRequest.response
          } : undefined,
          lastFailureRequest: value.lastFailureRequest ? {
            timestamp: value.lastFailureRequest.timestamp,
            request: value.lastFailureRequest.request,
            error: value.lastFailureRequest.error,
            statusCode: value.lastFailureRequest.statusCode
          } : undefined
        };
      });
      writeFileSync(this.statsFilePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error('Failed to save request stats to file:', error);
    }
  }

  /**
   * Call on service shutdown to persist final state
   */
  shutdown(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.saveToFile();
  }

  private buildKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }
}

// Use globalThis to prevent dual-singleton from esbuild bundling
// When multiple bundles include this module, only the first instance is created
const GLOBAL_KEY = '__CCR_REQUEST_STATS_SERVICE__' as const;
export const requestStatsService: RequestStatsService =
  (globalThis as any)[GLOBAL_KEY] ??
  ((globalThis as any)[GLOBAL_KEY] = new RequestStatsService());
