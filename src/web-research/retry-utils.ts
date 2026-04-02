/**
 * API Retry and Timeout Utilities
 *
 * Shared utilities for API rate limiting, retry logic with exponential backoff,
 * and timeout signal creation with Node.js compatibility.
 *
 * Used by: NVD, GitHub Advisories, OSV, CISA KEV, Search
 */

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Represents a timeout handle that can be optionally unreferenced
 */
interface TimeoutHandle {
  unref?(): void;
}

/**
 * Extend the global setTimeout return type for our purposes
 */
// Note: Global setTimeout is already properly typed in modern TypeScript/Node.js
// This ensures compatibility with our TimeoutHandle interface

// ============================================================================
// Retry Options
// ============================================================================

export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelay: number;
  readonly maxDelay: number;
}

// ============================================================================
// Timeout Signal Helper
// ============================================================================

/**
 * Helper function to create timeout signal with Node.js compatibility
 * AbortSignal.timeout() requires Node.js 14.17+, use fallback for older versions
 */
export function createTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  if ('timeout' in AbortSignal) {
    // Node.js 14.17+
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (signal) {
      return AbortSignal.any([signal, timeoutSignal]);
    }
    return timeoutSignal;
  } else {
    // Fallback for older Node.js versions
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    // Ensure timeout is cleared if signal is aborted externally
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
      }, { once: true });
    }
    // Unref so it doesn't keep the process alive
    (timeoutId as TimeoutHandle).unref?.();
    return controller.signal;
  }
}

// ============================================================================
// Retry with Exponential Backoff
// ============================================================================

/**
 * Retry helper with exponential backoff and jitter for transient errors.
 *
 * Retryable errors:
 * - HTTP 429 (rate limit)
 * - HTTP 5xx (server errors)
 *
 * Non-retryable errors:
 * - HTTP 4xx (client errors, except 429)
 * - Network errors that aren't timeout
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
    ...options,
  };

  let lastError: Error | null = null;
  let attempt = 0;

  while (attempt <= opts.maxRetries) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if this is a retryable error (429 rate limit or 5xx server errors)
      const isRetryable =
        lastError.message.includes('HTTP 429') ||
        lastError.message.includes('rate limit') ||
        lastError.message.includes('HTTP 5');

      if (!isRetryable || attempt === opts.maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      const baseDelay = opts.initialDelay * Math.pow(2, attempt);
      const jitter = Math.random() * 0.5 * baseDelay; // ±50% jitter
      const delay = Math.min(baseDelay + jitter, opts.maxDelay);

      console.warn(`[Retry] Request failed (attempt ${attempt + 1}/${opts.maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${lastError.message}`);

      // Unref the timeout so it doesn't prevent process exit
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
