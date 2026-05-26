/**
 * Browser Error Utilities
 *
 * Error detection and circuit breaker utilities for browser operations.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import { CircuitBreaker } from '../../utils/circuit-breaker.ts';
import type { NodeError } from '../../types/index.ts';

/**
 * Check if an error is a transient socket error that can be retried.
 */
export function isTransientSocketError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('socket hang up') ||
        err.message.includes('EPIPE') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('timed out') ||
        err.message.includes('pool busy') ||
        err.message.includes('unreachable') ||
        // WorkerPoolManager throws this during the window between forceSchedulerRestart
        // clearing the scheduler reference and the old pool's 1500ms drain completing.
        // It is a transient state — retry after a short delay succeeds once drain finishes.
        err.message.includes('Worker pool is shutting down') ||
        // Poolifier throws this when pool.execute() is called while the pool is being
        // destroyed (e.g., during scheduler restart). Treat as transient — the pool will
        // be ready for new tasks once destruction completes and a new pool is initialized.
        err.message.includes('Cannot execute a task on destroying pool') ||
        err.message.includes('destroying pool')
    );
}

/**
 * Check if an error is specifically a pool-shutdown / pool-drain error.
 * For these errors the scheduler itself is fine — only the WorkerPool is temporarily
 * draining. The correct recovery is to wait for the drain to finish and retry,
 * NOT to call forceSchedulerRestart (which would start another drain cycle).
 */
export function isPoolShutdownError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('Worker pool is shutting down') ||
        err.message.includes('Cannot execute a task on destroying pool') ||
        err.message.includes('destroying pool')
    );
}

/**
 * Circuit breaker for browser pool operations.
 * Handles transient socket errors with automatic retries.
 *
 * Pool-shutdown errors ("Worker pool is shutting down", "Cannot execute a task on
 * destroying pool") are expected transient states during a forceSchedulerRestart
 * drain window. They do NOT count toward the failure threshold — the pool will
 * recover on its own once the drain finishes. Only genuine connection failures
 * (ECONNREFUSED, ECONNRESET, etc.) indicate a broken service and should trip the
 * circuit.
 */
export const browserCircuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'BrowserPool',
    isTransientError: (error: unknown) => {
        // Don't count pool-drain transients toward the circuit breaker threshold.
        if (isPoolShutdownError(error)) return false;
        return isTransientSocketError(error);
    }
});

/**
 * Reset the browser circuit breaker to CLOSED state.
 * Call this in test teardown/setup to prevent cross-test circuit state bleed.
 */
export function resetBrowserCircuitBreaker(): void {
    browserCircuitBreaker.reset();
}