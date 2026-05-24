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
        err.message.includes('unreachable')
    );
}

/**
 * Circuit breaker for browser pool operations.
 * Handles transient socket errors with automatic retries.
 */
export const browserCircuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'BrowserPool',
    isTransientError: isTransientSocketError
});