/**
 * GPU Resource Service
 *
 * Manages GPU resource locking and coordination across processes.
 * Provides exclusive GPU access control with staleness detection.
 */

import type { SingletonState } from './state-manager.ts';
import { ProcessLifecycleService } from './process-lifecycle-service.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * GPU Resource Service
 *
 * Manages GPU resource locking with staleness detection and automatic recovery.
 * Ensures only one process can use GPU resources at a time.
 */
export class GPUResourceService {
  private readonly processLifecycle: ProcessLifecycleService;
  private readonly gpuLockStaleThresholdMs: number;

  constructor(options?: {
    processLifecycle?: ProcessLifecycleService;
    gpuLockStaleThresholdMs?: number;
  }) {
    this.processLifecycle = options?.processLifecycle ?? new ProcessLifecycleService();
    // 3 minutes balances responsiveness with tolerance for slow operations
    this.gpuLockStaleThresholdMs = options?.gpuLockStaleThresholdMs ?? 180000;
  }

  /**
   * Acquire the global GPU resource lock.
   * Only one process can hold the GPU lock at a time.
   *
   * @param updateState Function to atomically update state
   * @param sessionId Optional session ID for tracking
   * @param timeoutMs Maximum time to wait for the lock (default: 30 seconds)
   * @returns true if lock was acquired, false if timed out
   */
  async acquireGpuLock(
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>,
    sessionId?: string,
    timeoutMs: number = 30000
  ): Promise<boolean> {
    const startTime = Date.now();
    const retryDelay = 500;
    let retryCount = 0;

    while (Date.now() - startTime < timeoutMs) {
      let acquired = false;
      await updateState(async (state) => {
        const now = Date.now();
        const currentOwner = state.gpuOwner;

        if (currentOwner) {
          // If we are already the owner, just update startedAt (re-entrant/heartbeat)
          if (currentOwner.pid === this.processLifecycle.getCurrentPid()) {
            currentOwner.startedAt = now;
            if (sessionId) currentOwner.sessionId = sessionId;
            acquired = true;
            return state;
          }

          const isAlive = this.processLifecycle.isProcessAlive(currentOwner.pid);
          const lockAge = now - currentOwner.startedAt;

          if (isAlive && lockAge < this.gpuLockStaleThresholdMs) {
            // GPU is busy with a live process and lock is not stale
            return state;
          }

          // Either owner is dead OR lock is stale - reclaim
          if (!isAlive) {
            logger.warn(
              `[GPUResourceService] GPU owner PID ${currentOwner.pid} is dead. Reclaiming GPU lock.`
            );
          } else {
            logger.warn(
              `[GPUResourceService] GPU lock is stale (${lockAge}ms old, threshold is ${this.gpuLockStaleThresholdMs}ms). Reclaiming GPU lock.`
            );
          }
        }

        // Acquire lock
        state.gpuOwner = {
          pid: this.processLifecycle.getCurrentPid(),
          startedAt: now,
          sessionId,
        };
        acquired = true;
        return state;
      });

      if (acquired) {
        const duration = Date.now() - startTime;
        metrics.observe('gpu_lock_acquire_duration_ms', duration);
        metrics.increment('gpu_lock_acquire_total', 1, { status: 'success' });
        metrics.setGauge('gpu_lock_held', 1);
        if (retryCount > 0) {
          metrics.increment('gpu_lock_contention_total', 1);
          metrics.observe('gpu_lock_contention_retries', retryCount);
        }
        return true;
      }

      retryCount++;
      // Check if we still have time to wait
      if (Date.now() - startTime + retryDelay < timeoutMs) {
        await this.sleep(retryDelay);
      } else {
        break;
      }
    }

    metrics.increment('gpu_lock_acquire_total', 1, { status: 'timeout' });
    return false;
  }

  /**
   * Release the global GPU resource lock if held by this process.
   *
   * @param updateState Function to atomically update state
   * @param pid Optional PID to release for (defaults to current process)
   */
  async releaseGpuLock(
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>,
    pid: number = process.pid
  ): Promise<void> {
    await updateState((state) => {
      if (state.gpuOwner?.pid === pid) {
        delete state.gpuOwner;
        metrics.setGauge('gpu_lock_held', 0);
        metrics.increment('gpu_lock_release_total', 1, { status: 'success' });
      }
      return state;
    });
  }

  /**
   * Get information about the current GPU owner.
   *
   * @param readState Function to read current state
   * @returns GPU owner information or null if not locked
   */
  async getGpuOwner(
    readState: () => Promise<SingletonState>
  ): Promise<SingletonState['gpuOwner'] | null> {
    const state = await readState();
    return state.gpuOwner ?? null;
  }

  /**
   * Check if the GPU is currently locked.
   *
   * @param readState Function to read current state
   * @returns true if GPU is locked
   */
  async isGpuLocked(readState: () => Promise<SingletonState>): Promise<boolean> {
    const gpuOwner = await this.getGpuOwner(readState);
    return gpuOwner !== null;
  }

  /**
   * Check if the GPU lock is stale (older than threshold).
   *
   * @param readState Function to read current state
   * @param staleThresholdMs Custom staleness threshold (defaults to service threshold)
   * @returns true if lock is stale, false if not locked or not stale
   */
  async isGpuLockStale(
    readState: () => Promise<SingletonState>,
    staleThresholdMs?: number
  ): Promise<boolean> {
    const gpuOwner = await this.getGpuOwner(readState);
    if (!gpuOwner) return false;

    const threshold = staleThresholdMs ?? this.gpuLockStaleThresholdMs;
    const lockAge = Date.now() - gpuOwner.startedAt;
    return lockAge > threshold;
  }

  /**
   * Check if the current process holds the GPU lock.
   *
   * @param readState Function to read current state
   * @returns true if current process holds the lock
   */
  async doesCurrentProcessHoldGpuLock(readState: () => Promise<SingletonState>): Promise<boolean> {
    const gpuOwner = await this.getGpuOwner(readState);
    return gpuOwner?.pid === this.processLifecycle.getCurrentPid();
  }

  /**
   * Get the GPU lock staleness threshold in milliseconds.
   */
  getGpuLockStaleThresholdMs(): number {
    return this.gpuLockStaleThresholdMs;
  }

  /**
   * Sleep for a specified number of milliseconds
   * @param ms The number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}