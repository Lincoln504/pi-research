/**
 * Abort Signal Utilities
 *
 * Shared utilities for abortable operations with proper cleanup.
 * Consolidates abort signal handling across orchestrators.
 */

/**
 * Wraps a promise with AbortSignal support.
 * Handles event listener cleanup automatically.
 *
 * @param promise - The promise to make abortable
 * @param signal - Optional AbortSignal for cancellation
 * @returns A promise that rejects with an error when aborted
 */
export async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    throw new Error('Operation cancelled');
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      reject(new Error('Operation cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    abortHandler = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (abortHandler) {
      abortHandler();
    }
  }
}

/**
 * Create an abortable sleep promise.
 *
 * @param ms - Sleep duration in milliseconds
 * @param signal - Optional AbortSignal for cancellation
 * @returns A promise that resolves after the sleep duration
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return withAbort(
    new Promise<void>(resolve => setTimeout(resolve, ms)),
    signal
  );
}

/**
 * Create an abortable timeout promise.
 * Like withAbort but uses a timeout instead of an existing promise.
 *
 * @param ms - Timeout duration in milliseconds
 * @param signal - Optional AbortSignal for cancellation
 * @returns A promise that rejects when timeout is reached
 */
export function abortableTimeout(ms: number, signal?: AbortSignal): Promise<never> {
  return withAbort(
    new Promise<never>((_, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Operation timed out after ${ms}ms`));
      }, ms);
      if (timeoutId.unref) {
        timeoutId.unref();
      }
    }),
    signal
  );
}