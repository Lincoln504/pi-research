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

import { getConfig } from '../config.ts';
import type { Config } from '../config.ts';

/**
 * Create a timeout promise that rejects after the given duration.
 * Use Promise.race([actualWork, createTimeout(ms)]) to enforce deadlines.
 */
export function createTimeout(ms: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`LLM call timed out after ${ms}ms (${label})`));
    }, ms);
  });
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