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
 * Check if an error is a Cloudflare block/challenge error.
 * These are content-layer rejections, not infrastructure failures — they must NOT
 * count toward the circuit breaker failure threshold. Counting them caused the
 * breaker to open during normal searches and block all subsequent requests.
 */
export function isCloudflareBlockError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('Fetch blocked: Cloudflare') ||
        err.message.includes('Cloudflare challenge')
    );
}

/**
 * Check if an error is a task-level timeout (search/scrape/healthcheck timed out).
 * These indicate the remote site is slow or unresponsive — a normal occurrence during
 * a burst of 20 parallel queries. They must NOT trip the circuit breaker; only true
 * socket-layer infrastructure failures (ECONNREFUSED, ECONNRESET, etc.) should do so.
 */
export function isTaskTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('timed out after') ||
        err.message.includes('Search task timed out') ||
        err.message.includes('Scrape task timed out') ||
        err.message.includes('Health check timed out') ||
        err.message.includes('[BrowserClient] Request to')
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

// Session-scoped circuit breaker storage to support concurrent research runs
const sessionCircuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Default circuit breaker configuration
 */
const DEFAULT_BREAKER_CONFIG: any = {
    // Raised from 3→8: parallel search bursts of 20 queries frequently produce
    // simultaneous timeouts on slow/CF-protected sites. A threshold of 3 caused
    // the breaker to open mid-burst, blocking all subsequent requests for the round.
    failureThreshold: 8,
    // Raised from 15s→45s: enough time for one full search burst + retry window
    // to complete before the breaker attempts to half-open.
    resetTimeoutMs: 45000,
    name: 'BrowserPool',
    isTransientError: (error: unknown) => {
        // Pool-drain transients: pool recovers on its own — don't count.
        if (isPoolShutdownError(error)) return false;
        // Cloudflare blocks are content-layer rejections, not infra failures — don't count.
        if (isCloudflareBlockError(error)) return false;
        // Task-level timeouts (slow/unresponsive sites) are expected during parallel
        // search bursts — don't count toward the circuit breaker threshold.
        if (isTaskTimeoutError(error)) return false;
        // Only genuine socket-layer failures (ECONNREFUSED, ECONNRESET, etc.) trip the circuit.
        return isTransientSocketError(error);
    }
};

/**
 * Get or create a session-scoped circuit breaker
 */
export function getBrowserCircuitBreaker(sessionId: string): CircuitBreaker {
    let breaker = sessionCircuitBreakers.get(sessionId);
    if (!breaker) {
        breaker = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, name: `BrowserPool-${sessionId}` });
        sessionCircuitBreakers.set(sessionId, breaker);
    }
    return breaker;
}

/**
 * Clear a session's circuit breaker
 */
export function clearSessionCircuitBreaker(sessionId: string): void {
    sessionCircuitBreakers.delete(sessionId);
}

/**
 * Global fallback circuit breaker — used when no sessionId is available.
 */
export const browserCircuitBreaker = new CircuitBreaker(DEFAULT_BREAKER_CONFIG);

/**
 * Reset all browser circuit breakers
 * Call this in test teardown/setup to prevent cross-test circuit state bleed.
 */
export function resetBrowserCircuitBreaker(sessionId?: string): void {
    if (sessionId) {
        clearSessionCircuitBreaker(sessionId);
    } else {
        sessionCircuitBreakers.clear();
        browserCircuitBreaker.reset();
    }
}
