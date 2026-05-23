/**
 * Health Check Cache Manager
 *
 * Manages health check cache state without creating circular dependencies.
 * This module provides centralized health check cache management that can be
 * imported by both healthcheck and knowledge modules.
 *
 * The cache manager handles:
 * - Pending health check promises
 * - Health check failure counts
 * - Exponential backoff state
 * - Cache invalidation
 */

import type { HealthCheckResult } from './service-interfaces.ts';

// ============================================================================
// Health Check State
// ============================================================================

interface HealthCheckState {
  pending: Promise<HealthCheckResult> | null;
  failureCount: number;
  backoffUntil: number;
}

let _healthCheckState: HealthCheckState = {
  pending: null,
  failureCount: 0,
  backoffUntil: 0,
};

// ============================================================================
// Health Check Cache Manager
// ============================================================================

export class HealthCacheManager {
  private static instance: HealthCacheManager | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): HealthCacheManager {
    if (!HealthCacheManager.instance) {
      HealthCacheManager.instance = new HealthCacheManager();
    }
    return HealthCacheManager.instance;
  }

  /**
   * Get the pending health check promise
   */
  public getPending(): Promise<HealthCheckResult> | null {
    return _healthCheckState.pending;
  }

  /**
   * Set the pending health check promise
   */
  public setPending(promise: Promise<HealthCheckResult> | null): void {
    _healthCheckState.pending = promise;
  }

  /**
   * Get the health check failure count
   */
  public getFailureCount(): number {
    return _healthCheckState.failureCount;
  }

  /**
   * Increment the health check failure count and update backoff
   */
  public incrementFailureCount(): number {
    _healthCheckState.failureCount++;
    // Calculate exponential backoff: 2^(failureCount-1) * 2000ms, max 30s
    const backoffMs = Math.min(30000, 2000 * Math.pow(2, _healthCheckState.failureCount - 1));
    _healthCheckState.backoffUntil = Date.now() + backoffMs;
    return _healthCheckState.failureCount;
  }

  /**
   * Reset the health check failure count and backoff
   */
  public resetFailureCount(): void {
    if (_healthCheckState.failureCount > 0) {
      // Note: We use console here to avoid circular dependency with logger
      console.log(
        `[HealthCacheManager] Resetting healthcheck failure count from ${_healthCheckState.failureCount} to 0`
      );
    }
    _healthCheckState.failureCount = 0;
    _healthCheckState.backoffUntil = 0;
  }

  /**
   * Check if health check backoff is active
   */
  public isBackoffActive(): boolean {
    return Date.now() < _healthCheckState.backoffUntil;
  }

  /**
   * Get remaining health check backoff time in milliseconds
   */
  public getBackoffRemainingMs(): number {
    const remaining = _healthCheckState.backoffUntil - Date.now();
    return Math.max(0, remaining);
  }

  /**
   * Clear all health check cache state
   */
  public clear(): void {
    _healthCheckState.pending = null;
    _healthCheckState.failureCount = 0;
    _healthCheckState.backoffUntil = 0;
    console.debug('[HealthCacheManager] Health check cache cleared');
  }

  /**
   * Get a snapshot of the current health check state
   */
  public getStateSnapshot(): Readonly<HealthCheckState> {
    return { ..._healthCheckState };
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get the health cache manager singleton
 */
export function getHealthCacheManager(): HealthCacheManager {
  return HealthCacheManager.getInstance();
}

/**
 * Clear the health check cache (alias for manager.clear())
 */
export function clearHealthCheckCache(): void {
  getHealthCacheManager().clear();
}

/**
 * Get the pending health check promise
 */
export function getHealthCheckPending(): Promise<HealthCheckResult> | null {
  return getHealthCacheManager().getPending();
}

/**
 * Set the pending health check promise
 */
export function setHealthCheckPending(promise: Promise<HealthCheckResult> | null): void {
  getHealthCacheManager().setPending(promise);
}

/**
 * Get the health check failure count
 */
export function getHealthCheckFailureCount(): number {
  return getHealthCacheManager().getFailureCount();
}

/**
 * Increment the health check failure count
 */
export function incrementHealthCheckFailureCount(): number {
  return getHealthCacheManager().incrementFailureCount();
}

/**
 * Reset the health check failure count
 */
export function resetHealthCheckFailureCount(): void {
  getHealthCacheManager().resetFailureCount();
}

/**
 * Check if health check backoff is active
 */
export function isHealthCheckBackoffActive(): boolean {
  return getHealthCacheManager().isBackoffActive();
}

/**
 * Get remaining health check backoff time in milliseconds
 */
export function getHealthCheckBackoffRemainingMs(): number {
  return getHealthCacheManager().getBackoffRemainingMs();
}