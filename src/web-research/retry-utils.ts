/**
 * API Retry and Timeout Utilities
 *
 * Shared utilities for API rate limiting, retry logic with exponential backoff,
 * and timeout signal creation with Node.js compatibility.
 *
 * Used by: NVD, GitHub Advisories, OSV, CISA KEV, Search, Delegate Research
 */

import { logger } from '../logger.ts';

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
    timeoutId.unref();
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
 * Wraps a promise with a timeout and abort signal support
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  const combinedSignal = createTimeoutSignal(timeoutMs, signal);
    
  logger.log(`[withTimeout] Starting ${label} with timeout ${timeoutMs}ms. External signal aborted: ${signal?.aborted ?? 'no signal'}`);

  return new Promise<T>((resolve, reject) => {
    if (combinedSignal.aborted) {
      logger.error(`[withTimeout] ${label} ALREADY ABORTED at start`);
      return reject(new Error(`${label} cancelled or timed out`));
    }

    const abortHandler = () => {
      logger.error(`[withTimeout] ${label} ABORTED (timeout or external signal)`);
      reject(new Error(`${label} cancelled or timed out`));
    };
    
    combinedSignal.addEventListener('abort', abortHandler, { once: true });

    promise.then(
      (val) => {
        combinedSignal.removeEventListener('abort', abortHandler);
        resolve(val);
      },
      (err) => {
        combinedSignal.removeEventListener('abort', abortHandler);
        reject(err);
      }
    );
  });
}

// ============================================================================
// Retry with Exponential Backoff
// ============================================================================

/**
 * Default transient error detector
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();

  // Network errors
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('timeout') || message.includes('etimedout')) {
    return true;
  }

  // Rate limiting
  if (message.includes('429') || message.includes('rate') || message.includes('quota')) {
    return true;
  }

  // Temporary service unavailability or server errors
  if (
    message.includes('503') || 
    message.includes('500') || 
    message.includes('502') || 
    message.includes('504') ||
    message.includes('temporarily') || 
    message.includes('unavailable') ||
    message.includes('http 5')
  ) {
    return true;
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
  const opts: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    label: 'operation',
    isTransientError: options.isTransientError ?? isTransientError,
    ...options,
  };

  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= opts.maxRetries) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!opts.isTransientError(lastError) || attempt === opts.maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = opts.initialDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 0.5 * baseDelay; // ±50% jitter
      const delay = Math.min(baseDelay + jitter, opts.maxDelay);

      logger.warn(`[Retry] ${opts.label} failed (attempt ${attempt + 1}/${opts.maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${lastError.message}`);

      // Wait before retrying
      await new Promise<void>(resolve => {
        const timeoutId = setTimeout(resolve, delay);
        (timeoutId as TimeoutHandle).unref?.();
      });

      attempt++;
    }
  }

  // Should never reach here due to throw in loop, but for type safety
  throw lastError ?? new Error('All retries exhausted');
}
