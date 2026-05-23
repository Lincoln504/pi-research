/**
 * Stack Exchange REST API v2.3 Client
 * Handles API requests with rate limiting, quota tracking, and backoff handling
 */

import type { StackExchangeWrapper } from './types.ts';
import { logger } from '../logger.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';

const API_BASE = 'https://api.stackexchange.com/2.3';

export interface RequestOptions {
  method: string;
  endpoint: string;
  params: URLSearchParams;
}

export class StackExchangeClient {
  private readonly _apiKey: string | null;
  private readonly _timeout: number;
  private quotaRemaining = 300;
  private quotaMax = 300;
  private requestCount = 0;
  private lastBackoff: number | null = null;
  private circuitBreaker: CircuitBreaker;

  constructor(
    apiKey: string | null,
    timeout: number,
  ) {
    this._apiKey = apiKey;
    this._timeout = timeout;
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      name: 'StackExchange API',
      isTransientError: (err) => {
        if (err instanceof Error) {
            // Count network errors and 5xx errors, but not 4xx client errors (except 429)
            const msg = err.message.toLowerCase();
            return msg.includes('timeout') || msg.includes('network') || msg.includes('econn') || msg.includes('50') || msg.includes('429');
        }
        return true;
      }
    });
  }

  async request<T>(options: RequestOptions, signal?: AbortSignal): Promise<StackExchangeWrapper<T>> {
    const startTime = Date.now();
    return this.circuitBreaker.execute(async () => {
      // Check for backoff from previous requests
      if (this.lastBackoff && this.lastBackoff > Date.now()) {
        const waitTime = Math.ceil((this.lastBackoff - Date.now()) / 1000);
        metrics.increment('stackexchange_backoff_wait_total', 1);
        throw new Error(
          `Rate limited. Please wait ${waitTime} seconds before making more requests.`,
        );
      }

      const url = new URL(`${API_BASE}${options.endpoint}`);
      url.search = options.params.toString();

      // Add API key if provided
      if (this._apiKey) {
        url.searchParams.set('key', this._apiKey);
      }

      // Add site parameter if not already present (for methods that need it)
      if (!url.searchParams.has('site') && !options.endpoint.startsWith('/sites')) {
        url.searchParams.set('site', 'stackoverflow.com');
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this._timeout);

      // Chain the signal if provided
      const abortHandler = () => {
        clearTimeout(timeoutId);
        controller.abort();
      };
      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        const response = await fetch(url.toString(), {
          method: options.method,
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
          },
        });

        clearTimeout(timeoutId);

        const data = await response.json() as StackExchangeWrapper<T>;

        // Handle API errors
        if (data.error_id) {
          const errorName = data.error_name ?? 'unknown';
          metrics.increment('stackexchange_errors_total', 1, { 
            endpoint: options.endpoint, 
            error_id: data.error_id.toString(),
            error_name: errorName 
          });
          throw new Error(
            `Stack Exchange API Error (${data.error_id} - ${data.error_name}): ${data.error_message}`,
          );
        }

        // Update quota tracking
        this.quotaRemaining = data.quota_remaining;
        this.quotaMax = data.quota_max;
        this.requestCount++;
        
        // Track quota metrics
        metrics.setGauge('stackexchange_quota_remaining', this.quotaRemaining);
        metrics.setGauge('stackexchange_quota_max', this.quotaMax);
        metrics.setGauge('stackexchange_quota_used', this.quotaMax - this.quotaRemaining);

        // Handle backoff
        if (data.backoff) {
          this.lastBackoff = Date.now() + (data.backoff * 1000);
          metrics.increment('stackexchange_backoff_total', 1, { seconds: data.backoff.toString() });
          metrics.observe('stackexchange_backoff_duration_seconds', data.backoff);
          logger.warn(`[StackExchange] Backoff required: ${data.backoff} seconds`);
        }
        
        // Track successful requests
        metrics.increment('stackexchange_requests_total', 1, { endpoint: options.endpoint, status: 'success' });
        
        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        metrics.observe('stackexchange_request_duration_ms', duration, { endpoint: options.endpoint, status: 'error' });
        metrics.increment('stackexchange_requests_total', 1, { endpoint: options.endpoint, status: 'error' });
        
        if (error instanceof Error && error.name === 'AbortError') {
          metrics.increment('stackexchange_timeouts_total', 1, { endpoint: options.endpoint });
          throw new Error(`Request timeout after ${this._timeout}ms`, { cause: error });
        }

        throw error;
      } finally {
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      }
    });
  }

  getQuotaInfo(): { remaining: number; max: number; requestCount: number; lastBackoff: number | null } {
    const info = {
      remaining: this.quotaRemaining,
      max: this.quotaMax,
      requestCount: this.requestCount,
      lastBackoff: this.lastBackoff,
    };
    
    // Track quota exhaustion events
    if (this.isQuotaExhausted()) {
      metrics.increment('stackexchange_quota_exhausted_total', 1);
    }
    
    if (this.isQuotaLow()) {
      metrics.increment('stackexchange_quota_low_total', 1);
    }
    
    return info;
  }

  isQuotaExhausted(): boolean {
    return this.quotaRemaining <= 0;
  }

  isQuotaLow(): boolean {
    return this.quotaRemaining < 30; // Warn when less than 30 requests remain
  }
}
