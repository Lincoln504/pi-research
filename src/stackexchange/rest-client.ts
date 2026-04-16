/**
 * Stack Exchange REST API v2.3 Client
 * Handles API requests with rate limiting, quota tracking, and backoff handling
 */

import type { StackExchangeWrapper } from './types.ts';
import { logger } from '../logger.ts';

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

  constructor(
    apiKey: string | null,
    timeout: number,
  ) {
    this._apiKey = apiKey;
    this._timeout = timeout;
  }

  async request<T>(options: RequestOptions, signal?: AbortSignal): Promise<StackExchangeWrapper<T>> {
    // Check for backoff from previous requests
    if (this.lastBackoff && this.lastBackoff > Date.now()) {
      const waitTime = Math.ceil((this.lastBackoff - Date.now()) / 1000);
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
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        controller.abort();
      });
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
        throw new Error(
          `Stack Exchange API Error (${data.error_id} - ${data.error_name}): ${data.error_message}`,
        );
      }

      // Update quota tracking
      this.quotaRemaining = data.quota_remaining;
      this.quotaMax = data.quota_max;
      this.requestCount++;

      // Handle backoff
      if (data.backoff) {
        this.lastBackoff = Date.now() + (data.backoff * 1000);
        logger.warn(`[StackExchange] Backoff required: ${data.backoff} seconds`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this._timeout}ms`, { cause: error });
      }

      throw error;
    }
  }

  getQuotaInfo(): { remaining: number; max: number; requestCount: number; lastBackoff: number | null } {
    return {
      remaining: this.quotaRemaining,
      max: this.quotaMax,
      requestCount: this.requestCount,
      lastBackoff: this.lastBackoff,
    };
  }

  isQuotaExhausted(): boolean {
    return this.quotaRemaining <= 0;
  }

  isQuotaLow(): boolean {
    return this.quotaRemaining < 30; // Warn when less than 30 requests remain
  }
}
