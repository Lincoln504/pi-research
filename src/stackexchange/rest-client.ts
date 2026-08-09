/**
 * Stack Exchange REST API v2.3 Client
 * Handles API requests with rate limiting, quota tracking, and backoff handling
 */

import type { StackExchangeWrapper } from './types.ts';
import { logger } from '../logger.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';
import { readJsonCapped, BodyTooLargeError } from '../utils/http-body.ts';
import { createTimeoutSignal } from '../web-research/retry-utils.ts';

const API_BASE = 'https://api.stackexchange.com/2.3';

// How long quota-exhaustion evidence keeps the request gate armed. quotaRemaining
// is only refreshed from a successful response, and the tool-level gate
// (stackexchange/index.ts) blocks every request while isQuotaExhausted() — so a
// plain `quotaRemaining <= 0` check could never observe SE's real daily reset and
// wedged the process-wide client until restart or an API-key change. After the
// cooldown one probe request is allowed: it either refreshes the quota (clearing
// the stamp) or shows 0 / throttles again, re-arming the gate — at most one
// wasted request per cooldown.
const QUOTA_PROBE_COOLDOWN_MS = 10 * 60 * 1000;

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
  // Timestamp of the last quota-exhaustion evidence (a response reporting
  // quota_remaining <= 0, or a throttle_violation API error). null = no evidence.
  private quotaExhaustedAt: number | null = null;
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
      resetTimeoutMs: 10000,
      name: 'StackExchange API',
      isTransientError: (err) => {
        if (err instanceof Error) {
            // Count network errors and 5xx errors, but not 4xx client errors (except 429).
            // Match status codes on a word boundary so an incidental "50"/"429" inside a
            // larger number (e.g. a token count) does not spuriously look transient — same
            // class as the word-boundary fix in isTransientSynthesisError.
            const msg = err.message.toLowerCase();
            return msg.includes('timeout') || msg.includes('network') || msg.includes('econn') || /\b5\d\d\b/.test(msg) || /\b429\b/.test(msg);
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

      // createTimeoutSignal combines the timeout with an already-provided caller
      // signal via AbortSignal.any, which — unlike a plain `signal.addEventListener
      // ('abort', ...)` — correctly produces an already-aborted combined signal
      // when the caller's signal is aborted BEFORE this call even starts (that
      // 'abort' event already fired; a listener added afterward never sees it, so
      // the request went to the network anyway despite the caller having already
      // cancelled). Matches the same pattern used by the security/*.ts clients.
      const requestSignal = createTimeoutSignal(this._timeout, signal);

      try {
        const response = await fetch(url.toString(), {
          method: options.method,
          signal: requestSignal,
          headers: {
            'Accept': 'application/json',
          },
        });

        // NB: requestSignal stays armed through the body read below (readJsonCapped) —
        // createTimeoutSignal's underlying timer isn't cleared just because fetch()
        // resolved with headers, so a stalled body still aborts rather than hanging
        // for the whole process lifetime.

        // The SE API returns a structured JSON wrapper (with error_id) even for
        // logical errors, so we still parse on non-2xx. But a maintenance page /
        // CDN interstitial is non-JSON: surface it as an HTTP status error (which
        // the circuit breaker recognizes as transient) instead of an opaque
        // "Unexpected token <" SyntaxError that hides the real cause.
        let data: StackExchangeWrapper<T>;
        try {
          data = await readJsonCapped<StackExchangeWrapper<T>>(response);
        } catch (parseErr) {
          // An over-cap body is a size failure, not a malformed-JSON one: rethrow
          // it unwrapped so it can't be relabelled as an HTTP-status error below.
          if (parseErr instanceof BodyTooLargeError) throw parseErr;
          if (!response.ok) throw new Error(`HTTP ${response.status} from Stack Exchange API`, { cause: parseErr });
          throw parseErr;
        }

        // Handle API errors
        if (data.error_id) {
          const errorName = data.error_name ?? 'unknown';
          // A throttle_violation is quota-exhaustion evidence even though no
          // quota_remaining arrives with it (this throw happens before the quota
          // update below) — stamp it so the gate arms/re-arms.
          if (errorName === 'throttle_violation') {
            this.quotaExhaustedAt = Date.now();
          }
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
        // Stamp (or clear) exhaustion evidence: isQuotaExhausted() reads the
        // stamp, not quotaRemaining — which can never refresh while the gate
        // blocks requests — so a probe after the cooldown self-corrects once
        // SE's daily reset has happened.
        if (data.quota_remaining <= 0) {
          this.quotaExhaustedAt = Date.now();
        } else {
          this.quotaExhaustedAt = null;
        }
        
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
        const duration = Date.now() - startTime;
        metrics.observe('stackexchange_request_duration_ms', duration, { endpoint: options.endpoint, status: 'error' });
        metrics.increment('stackexchange_requests_total', 1, { endpoint: options.endpoint, status: 'error' });
        
        if (error instanceof Error && error.name === 'AbortError') {
          metrics.increment('stackexchange_timeouts_total', 1, { endpoint: options.endpoint });
          throw new Error(`Request timeout after ${this._timeout}ms`, { cause: error });
        }

        throw error;
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
    // True only within the probe cooldown of the last exhaustion evidence. After
    // it elapses, one probe request is allowed through the tool-level gate; the
    // probe's outcome refreshes or clears the stamp (see request()).
    return (
      this.quotaExhaustedAt !== null &&
      Date.now() - this.quotaExhaustedAt < QUOTA_PROBE_COOLDOWN_MS
    );
  }

  isQuotaLow(): boolean {
    return this.quotaRemaining < 30; // Warn when less than 30 requests remain
  }
}
