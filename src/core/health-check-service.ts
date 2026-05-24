/**
 * Health Check Service
 *
 * Manages health check cache state and backoff logic.
 * Provides thread-safe access to health check state and prevents
 * thundering herd problems during health checks.
 */

import type { IHealthCheckService, HealthCheckResult } from './service-interfaces.ts';
import { ServiceLifecycle } from './service-registry.ts';
import { logger } from '../logger.ts';

/**
 * Default backoff configuration
 */
const DEFAULT_BACKOFF_BASE_MS = 1000; // 1 second
const DEFAULT_BACKOFF_MAX_MS = 60000; // 1 minute
const DEFAULT_BACKOFF_MULTIPLIER = 2;

/**
 * Health Check Service Implementation
 */
export class HealthCheckService implements IHealthCheckService {
  readonly name = 'health-check-cache';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // Thread-safe state management using atomic operations
  private _pendingCheck: Promise<HealthCheckResult> | null = null;
  private _failureCount: number = 0;
  private _backoffUntil: number = 0;
  
  // Backoff configuration
  private readonly _backoffBaseMs: number;
  private readonly _backoffMaxMs: number;
  private readonly _backoffMultiplier: number;

  constructor(options?: {
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    backoffMultiplier?: number;
  }) {
    this._backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this._backoffMaxMs = options?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this._backoffMultiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  }

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[HealthCheckService] Initializing...');

    // Initialize with default state
    this._pendingCheck = null;
    this._failureCount = 0;
    this._backoffUntil = 0;

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[HealthCheckService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[HealthCheckService] Disposing...');

    // Clear state
    this.clear();

    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[HealthCheckService] Disposed');
  }

  /**
   * Get the cached pending health check promise
   */
  getPendingCheck(): Promise<HealthCheckResult> | null {
    return this._pendingCheck;
  }

  /**
   * Set a pending health check promise
   * This should only be called from orchestration code that coordinates health checks
   */
  setPendingCheck(promise: Promise<HealthCheckResult> | null): void {
    this._pendingCheck = promise;

    // Clean up the promise when it settles to avoid memory leaks
    if (promise) {
      promise.finally(() => {
        // Only clear if this is still the same promise
        if (this._pendingCheck === promise) {
          this._pendingCheck = null;
        }
      });
    }
  }

  /**
   * Get the failure count
   */
  getFailureCount(): number {
    return this._failureCount;
  }

  /**
   * Increment the failure count
   */
  incrementFailureCount(): void {
    this._failureCount++;
    logger.debug(`[HealthCheckService] Failure count incremented to ${this._failureCount}`);
  }

  /**
   * Reset the failure count
   */
  resetFailureCount(): void {
    if (this._failureCount > 0) {
      logger.debug(`[HealthCheckService] Failure count reset from ${this._failureCount} to 0`);
    }
    this._failureCount = 0;
  }

  /**
   * Get the backoff timestamp
   */
  getBackoffUntil(): number {
    return this._backoffUntil;
  }

  /**
   * Set the backoff timestamp
   */
  setBackoffUntil(timestamp: number): void {
    this._backoffUntil = timestamp;
    const remainingMs = Math.max(0, timestamp - Date.now());
    if (remainingMs > 0) {
      logger.debug(`[HealthCheckService] Backoff set: ${remainingMs}ms remaining`);
    }
  }

  /**
   * Clear all cache state
   */
  clear(): void {
    this._pendingCheck = null;
    this._failureCount = 0;
    this._backoffUntil = 0;
    logger.debug('[HealthCheckService] Cache cleared');
  }

  /**
   * Check if a backoff is currently active
   */
  isBackoffActive(): boolean {
    return Date.now() < this._backoffUntil;
  }

  /**
   * Get remaining backoff time in milliseconds
   */
  getBackoffRemainingMs(): number {
    return Math.max(0, this._backoffUntil - Date.now());
  }

  /**
   * Calculate the next backoff duration based on failure count
   * Uses exponential backoff with jitter
   */
  calculateNextBackoffMs(): number {
    // Exponential backoff: base * 2^failures, capped at max
    const backoffMs = Math.min(
      this._backoffBaseMs * Math.pow(this._backoffMultiplier, this._failureCount),
      this._backoffMaxMs
    );

    // Add jitter (±25%) to prevent thundering herd
    const jitter = backoffMs * 0.25 * (Math.random() * 2 - 1);

    return Math.floor(backoffMs + jitter);
  }

  /**
   * Set backoff based on current failure count
   */
  setBackoff(): void {
    const backoffMs = this.calculateNextBackoffMs();
    this._backoffUntil = Date.now() + backoffMs;
    logger.debug(`[HealthCheckService] Backoff set: ${backoffMs}ms (${this._failureCount} failures)`);
  }

  /**
   * Record a health check failure
   * Increments failure count and sets backoff
   */
  recordFailure(): void {
    this.incrementFailureCount();
    this.setBackoff();
  }

  /**
   * Record a health check success
   * Resets failure count and clears backoff
   */
  recordSuccess(): void {
    this.resetFailureCount();
    this._backoffUntil = 0;
    logger.debug('[HealthCheckService] Health check success recorded');
  }

  /**
   * Get the current backoff state as an object
   */
  getBackoffState(): {
    isActive: boolean;
    remainingMs: number;
    failureCount: number;
    nextBackoffMs: number;
  } {
    return {
      isActive: this.isBackoffActive(),
      remainingMs: this.getBackoffRemainingMs(),
      failureCount: this._failureCount,
      nextBackoffMs: this.calculateNextBackoffMs(),
    };
  }

  /**
   * Wait for backoff to complete if active
   * Returns immediately if no backoff is active
   */
  async waitForBackoff(): Promise<void> {
    const remainingMs = this.getBackoffRemainingMs();
    if (remainingMs > 0) {
      logger.debug(`[HealthCheckService] Waiting for backoff: ${remainingMs}ms`);
      await new Promise(resolve => setTimeout(resolve, remainingMs));
      logger.debug('[HealthCheckService] Backoff complete');
    }
  }

  /**
   * Check if a new health check should be allowed
   * Returns false if backoff is active or a check is already pending
   */
  shouldAllowCheck(): boolean {
    if (this._pendingCheck !== null) {
      logger.debug('[HealthCheckService] Check not allowed: already pending');
      return false;
    }

    if (this.isBackoffActive()) {
      const remainingMs = this.getBackoffRemainingMs();
      logger.debug(`[HealthCheckService] Check not allowed: backoff active (${remainingMs}ms remaining)`);
      return false;
    }

    return true;
  }
}