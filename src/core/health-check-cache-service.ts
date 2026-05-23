/**
 * Health Check Cache Service
 *
 * This service manages the health check promise cache and backoff state.
 * It replaces the global __PI_RESEARCH_HEALTH_CHECK_PENDING__ variable.
 */

import type { IHealthCheckService, HealthCheckResult } from '../core/service-interfaces.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { logger } from '../logger.ts';

/**
 * HealthCheckCacheService implementation
 */
export class HealthCheckCacheService implements IHealthCheckService {
  readonly name = 'health-check-cache';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private _pending: Promise<HealthCheckResult> | null = null;
  private _failureCount: number = 0;
  private _backoffUntil: number = 0;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[HealthCheckCacheService] Initialized');
  }

  async dispose(): Promise<void> {
    this.clear();
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[HealthCheckCacheService] Disposed');
  }

  getPendingCheck(): Promise<HealthCheckResult> | null {
    return this._pending;
  }

  setPendingCheck(promise: Promise<HealthCheckResult> | null): void {
    this._pending = promise;
  }

  getFailureCount(): number {
    return this._failureCount;
  }

  incrementFailureCount(): void {
    this._failureCount++;
    // Calculate exponential backoff: 2^(failureCount-1) * 2000ms, max 30s
    const backoffMs = Math.min(30000, 2000 * Math.pow(2, this._failureCount - 1));
    this._backoffUntil = Date.now() + backoffMs;
    logger.warn(
      `[HealthCheckCacheService] Failure count: ${this._failureCount}, ` +
      `backoff set for ${backoffMs}ms`
    );
  }

  resetFailureCount(): void {
    if (this._failureCount > 0) {
      logger.log(
        `[HealthCheckCacheService] Resetting failure count from ${this._failureCount} to 0`
      );
    }
    this._failureCount = 0;
    this._backoffUntil = 0;
  }

  getBackoffUntil(): number {
    return this._backoffUntil;
  }

  setBackoffUntil(timestamp: number): void {
    this._backoffUntil = timestamp;
  }

  clear(): void {
    this._pending = null;
    this._failureCount = 0;
    this._backoffUntil = 0;
    logger.debug('[HealthCheckCacheService] Cache cleared');
  }

  isBackoffActive(): boolean {
    return Date.now() < this._backoffUntil;
  }

  getBackoffRemainingMs(): number {
    const remaining = this._backoffUntil - Date.now();
    return Math.max(0, remaining);
  }
}

// ============================================================================
// Singleton Accessor (for backward compatibility)
// ============================================================================

let _healthCheckCacheInstance: HealthCheckCacheService | null = null;

/**
 * Get or create the health check cache service instance
 */
export function getHealthCheckCacheService(): HealthCheckCacheService {
  if (!_healthCheckCacheInstance) {
    _healthCheckCacheInstance = new HealthCheckCacheService();
    _healthCheckCacheInstance.initialize().catch(err => {
      logger.error('[HealthCheckCacheService] Failed to initialize:', err);
    });
  }
  return _healthCheckCacheInstance;
}

/**
 * Reset the health check cache service instance
 * Primarily used for testing
 */
export function resetHealthCheckCacheService(): void {
  if (_healthCheckCacheInstance) {
    _healthCheckCacheInstance.dispose().catch(err => {
      logger.error('[HealthCheckCacheService] Failed to dispose:', err);
    });
  }
  _healthCheckCacheInstance = null;
}