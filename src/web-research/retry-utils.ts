import { safeUnref } from '../utils/safe-unref.ts';
/**
 * API Retry and Timeout Utilities
 *
 * Shared utilities for API rate limiting, retry logic with exponential backoff,
 * and timeout signal creation with Node.js compatibility.
 *
 * Used by: NVD, GitHub Advisories, OSV, CISA KEV, Search, Delegate Research
 */

import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a timeout handle that can be optionally unreferenced
 */
interface TimeoutHandle {
  unref?(): void;
}

// ============================================================================
// Retry Options
// ============================================================================

export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
  readonly label?: string;
  readonly isTransientError?: (error: unknown) => boolean;
  // When provided, aborting it short-circuits the inter-attempt backoff wait and
  // stops further retries, so a caller cancel isn't stuck behind a long sleep.
  readonly signal?: AbortSignal;
}

/**
 * Sleep for `ms`, resolving early (rejecting with an AbortError) if `signal`
 * aborts. The timer is unref'd so it never keeps the event loop alive.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      return;
    }
    const timeoutId = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timeoutId as TimeoutHandle).unref?.();
    const onAbort = signal
      ? () => {
          clearTimeout(timeoutId as unknown as ReturnType<typeof setTimeout>);
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        }
      : undefined;
    if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ============================================================================
// Timeout Signal Helper
// ============================================================================

/**
 * Helper function to create timeout signal.
 * Handles Node.js version compatibility for AbortSignal.any() and AbortSignal.timeout()
 */
export function createTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  // Check if modern AbortSignal methods are available (Node.js 20+)
  if (typeof AbortSignal.timeout === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (signal && typeof AbortSignal.any === 'function') {
      try {
        return AbortSignal.any([signal, timeoutSignal]);
      } catch (e) {
        // Fallback if AbortSignal.any fails or is not quite right
        logger.warn(`[createTimeoutSignal] AbortSignal.any failed, falling back to manual combination: ${e}`);
      }
    }
    if (!signal) return timeoutSignal;
  }
  
  // Fallback for older Node.js versions or if signal combination is needed manually
  const controller = new AbortController();
  const combinedController = signal ? new AbortController() : controller;
  
  const timeoutId = setTimeout(() => {
    combinedController.abort('timeout');
  }, timeoutMs);
  
  // Unref so it doesn't keep the process alive
  if (typeof timeoutId.unref === 'function') {
    safeUnref(timeoutId);
  }
  
  if (signal) {
    const abortHandler = () => {
      clearTimeout(timeoutId);
      combinedController.abort();
    };
    
    signal.addEventListener('abort', abortHandler, { once: true });
    
    // Also clean up signal listener if timeout fires first
    combinedController.signal.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abortHandler);
    }, { once: true });
  }
  
  return combinedController.signal;
}

/**
 * Wraps a promise with a timeout and abort signal support.
 * Ensures cleanup of event listeners on resolution/rejection.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  const combinedSignal = createTimeoutSignal(timeoutMs, signal);

  logger.debug(`[withTimeout] Starting ${timeoutMs}ms timeout guard (external signal: ${signal?.aborted ?? 'no signal'})`);

  return new Promise<T>((resolve, reject) => {
    // Early abort check: if signal is already aborted, reject immediately. Already
    // aborted before we start means an external (user) cancellation, not a timeout —
    // a clean stop, so log at debug, not error.
    if (combinedSignal.aborted) {
      logger.debug(`[withTimeout] ${label} already aborted at start (external cancellation)`);
      return reject(new Error(`${label} cancelled or timed out`));
    }

    let settled = false;
    const abortHandler = () => {
      if (!settled) {
        settled = true;
        // Distinguish a user/external cancellation (clean — debug) from a genuine
        // timeout (worth a warning). The reject text keeps both words so downstream
        // transient-classification on "timed out" is unaffected.
        if (signal?.aborted) {
          logger.debug(`[withTimeout] ${label} cancelled (external signal)`);
        } else {
          logger.warn(`[withTimeout] ${label} timed out after ${timeoutMs}ms`);
        }
        reject(new Error(`${label} cancelled or timed out`));
      }
    };

    combinedSignal.addEventListener('abort', abortHandler, { once: true });

    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          combinedSignal.removeEventListener('abort', abortHandler);
          resolve(val);
        }
      },
      (err) => {
        if (!settled) {
          settled = true;
          combinedSignal.removeEventListener('abort', abortHandler);
          reject(err);
        }
      }
    );
  });
}

// ============================================================================
// Retry with Exponential Backoff
// ============================================================================

/**
 * True if a single error MESSAGE carries a transient signal. Split out so the same
 * matching is applied both to the top-level error and to each link of a `cause`
 * chain (undici nests the real socket reason under `error.cause`).
 */
function messageIsTransient(message: string): boolean {
  const m = message.toLowerCase();

  // Network / socket-layer transport failures, including undici's mid-stream aborts:
  // a dropped streaming response surfaces as `TypeError: terminated` (cause
  // "other side closed" / UND_ERR_SOCKET / ECONNRESET). "timed out" is NOT included
  // here on purpose — the generic classifier keeps "timeout"/"etimedout"; the LLM
  // wrapper's "cancelled or timed out" wording is handled by the planning-service
  // classifier, so a security/youtube caller's abort string isn't reinterpreted.
  if (
    m.includes('econnrefused') || m.includes('enotfound') || m.includes('timeout') ||
    m.includes('etimedout') || m.includes('econnreset') || m.includes('fetch failed') ||
    m.includes('terminated') || m.includes('other side closed') ||
    m.includes('socket hang up') || m.includes('und_err')
  ) {
    return true;
  }

  // Rate limiting. Anchor on word boundaries so we don't treat "generate",
  // "moderate" (contain "rate") or "429" embedded in a larger number as
  // transient — matching the StackExchange client's boundary-anchored guard.
  if (/\b429\b/.test(m) || /\brate\b/.test(m) || m.includes('quota')) {
    return true;
  }

  // Temporary service unavailability, provider overload, or 5xx server errors.
  // \b5\d\d\b matches a standalone 5xx code without matching a substring of e.g. "50000".
  if (
    /\b5\d\d\b/.test(m) ||
    m.includes('temporarily') ||
    m.includes('unavailable') ||
    m.includes('overloaded')
  ) {
    return true;
  }

  return false;
}

/**
 * Default transient error detector. Inspects the error message AND walks the
 * `cause` chain (bounded) plus any Node/undici error `code`, so a wrapped transport
 * failure (undici nests the socket reason under `cause`) is still recognized on the
 * direct-fetch paths where that chain survives.
 */
export function isTransientError(error: unknown): boolean {
  // Reading .message/.cause/.code are plain property accesses on normal Error/undici objects,
  // but guard against a pathological throwing getter so classification can never crash the
  // retry loop — fail safe toward "not transient" (i.e. fail fast) if inspection throws.
  try {
    let current: unknown = error;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      if (messageIsTransient(current.message)) {
        return true;
      }
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && (/^und_err/i.test(code) || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND')) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Retry helper with exponential backoff and jitter for transient errors.
 *
 * @param fn - The async function to retry
 * @param options - Retry configuration
 * @returns The result of the successful execution
 * @throws The last error if all retries are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts: Required<Omit<RetryOptions, 'signal'>> & { signal?: AbortSignal } = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    label: 'operation',
    isTransientError: options.isTransientError ?? isTransientError,
    ...options,
  };

  const startTime = Date.now();
  let lastError: Error | null = null;
  let attempt = 0;
  metrics.increment('retry_attempts_total', 1, { label: opts.label });

  while (attempt <= opts.maxRetries) {
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      metrics.observe('retry_duration_ms', duration, { label: opts.label, status: 'success' });
      if (attempt > 0) {
        metrics.increment('retry_successful_after_retries_total', 1, { attempt: String(attempt), label: opts.label });
      }
      return result;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!opts.isTransientError(lastError) || attempt === opts.maxRetries) {
        const duration = Date.now() - startTime;
        metrics.observe('retry_duration_ms', duration, { label: opts.label, status: 'exhausted' });
        metrics.increment('retry_exhausted_total', 1, { label: opts.label });
        if (!opts.isTransientError(lastError)) {
          metrics.increment('retry_non_transient_errors_total', 1, { label: opts.label });
        }
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = opts.initialDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 0.5 * baseDelay; // ±50% jitter
      const delay = Math.min(baseDelay + jitter, opts.maxDelay);

      metrics.increment('retry_backoff_total', 1, { attempt: String(attempt), label: opts.label });
      metrics.observe('retry_backoff_delay_ms', delay, { attempt: String(attempt), label: opts.label });
      logger.warn(`[Retry] ${opts.label} failed (attempt ${attempt + 1}/${opts.maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${lastError.message}`);

      // Wait before retrying — abortable so a caller cancel doesn't sit through
      // the full backoff. If the wait is aborted, surface the original transient
      // error (not the synthetic AbortError) so callers see the real cause.
      try {
        await abortableDelay(delay, opts.signal);
      } catch {
        metrics.increment('retry_aborted_total', 1, { label: opts.label });
        throw lastError;
      }

      attempt++;
    }
  }

  // Should never reach here due to throw in loop, but for type safety
  throw lastError ?? new Error('All retries exhausted');
}
