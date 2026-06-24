/**
 * LLM Timeout Utility
 *
 * Provides a consistent timeout mechanism for all unprotected LLM call sites
 * (coordinator, evaluator, agentic repair, knowledge synthesis).
 *
 * Uses Promise.race to enforce a hard deadline. On timeout, the promise
 * rejects with a clear error message — the caller is expected to catch
 * and handle this gracefully (e.g., fallback plan, synthesized answer, etc.).
 */

import { getConfig } from '../../config.ts';
import type { Config } from '../../config.ts';

/**
 * Create a cancelable timeout. Returns the racing promise plus a `cancel()` that
 * clears the underlying timer.
 *
 * Always pair the race with `cancel()` in a `finally` so the timer does not
 * outlive the work it guards — an un-cleared `setTimeout(ms)` (ms defaults to
 * 300_000) keeps a closure pinned and a handle on the event loop for up to five
 * minutes after the real call has already settled, which accumulates under batch
 * load. See {@link withTimeout} for the convenience wrapper that does this for you.
 */
export function createCancelableTimeout(
  ms: number,
  label: string,
): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new Error(`LLM call timed out after ${ms}ms (${label})`));
    }, ms);
  });
  return { promise, cancel: () => { if (handle) clearTimeout(handle); } };
}

/**
 * Race `work` against a timeout, clearing the timer as soon as either settles.
 * The leak-free standard for enforcing an LLM-call deadline — use this instead
 * of `Promise.race([work, <bare timeout>])`, which leaves the timer running.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  const timeout = createCancelableTimeout(ms, label);
  try {
    return await Promise.race([work, timeout.promise]);
  } finally {
    timeout.cancel();
  }
}

/**
 * Resolve the active LLM timeout from the current Config.
 * Falls back to 300s (5 min) if Config is unavailable in the current context.
 */
export function getLlmTimeoutMs(config?: Config): number {
  try {
    const cfg = config ?? getConfig();
    return cfg.LLM_TIMEOUT_MS;
  } catch {
    // Config may not be available in certain test/minimal contexts
    return 300_000;
  }
}