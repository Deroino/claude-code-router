/**
 * Request Statistics Service
 * Tracks success/failure counts for API requests by provider:model dimension
 * Only stores the last request/response to prevent memory bloat
 */

import { EventEmitter } from 'events';

export interface RequestStats {
  success: number;
  fail: number;
  lastRequest?: {
    timestamp: string;
    request: any;
    response?: any;
    error?: string;
    statusCode?: number;
  };
}

export class RequestStatsService extends EventEmitter {
  private stats: Map<string, RequestStats> = new Map();

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

  recordSuccess(provider: string, model: string, request: any, response: any): void {
    const key = this.buildKey(provider, model);
    const existing = this.stats.get(key) || { success: 0, fail: 0 };
    const newStats = {
      success: existing.success + 1,
      fail: existing.fail,
      lastRequest: { timestamp: new Date().toISOString(), request, response }
    };
    this.stats.set(key, newStats);
    this.emit('stats_update', { key, stats: newStats });
  }

  recordFailure(provider: string, model: string, request: any, error: string, statusCode?: number): void {
    const key = this.buildKey(provider, model);
    const existing = this.stats.get(key) || { success: 0, fail: 0 };
    const newStats = {
      success: existing.success,
      fail: existing.fail + 1,
      lastRequest: { timestamp: new Date().toISOString(), request, error, statusCode }
    };
    this.stats.set(key, newStats);
    this.emit('stats_update', { key, stats: newStats });
  }

  clearAll(): void {
    this.stats.clear();
    this.emit('stats_clear');
  }

  private buildKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }
}

export const requestStatsService = new RequestStatsService();
