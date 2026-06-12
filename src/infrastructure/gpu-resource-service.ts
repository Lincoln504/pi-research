/**
 * GPU Resource Service
 *
 * Service wrapper for GPU resource management.
 * Provides clean interface for acquiring and releasing the global GPU lock.
 */

import { ServiceLifecycle, getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { logger } from '../logger.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IGPUResourceService, IProcessLifecycle, IStateManager } from '../core/service-interfaces.ts';
import type { SingletonState } from './types/state-types.ts';

/**
 * GPU Resource Service Options
 */
export interface GPUResourceServiceOptions {
  processLifecycle: IProcessLifecycle;
  gpuLockStaleThresholdMs?: number;
}

/**
 * GPU Resource Service Implementation
 */
export class GPUResourceService implements IGPUResourceService {
  readonly name = ServiceNames.GPU_RESOURCE_SERVICE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private processLifecycle: IProcessLifecycle | null = null;
  private gpuLockStaleThresholdMs: number = 1000 * 60 * 5; // 5 minutes default

  constructor(options?: GPUResourceServiceOptions) {
    if (options) {
      this.processLifecycle = options.processLifecycle;
      if (options.gpuLockStaleThresholdMs) {
        this.gpuLockStaleThresholdMs = options.gpuLockStaleThresholdMs;
      }
    }
  }

  async initialize(ctx?: any): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[GPUResourceService] Initializing...');

    const container = tryGetServiceContainerFromCtx(ctx);

    if (!this.processLifecycle) {
      this.processLifecycle = await getService<IProcessLifecycle>(ServiceNames.PROCESS_LIFECYCLE, ctx, container);
    }

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[GPUResourceService] Initialized');
  }

  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Internal logic to acquire the GPU lock
   */
  private async performAcquireGpuLock(
    updateState: (updater: (state: SingletonState) => SingletonState | Promise<SingletonState>) => Promise<void>,
    sessionId?: string,
    timeoutMs?: number
  ): Promise<boolean> {
    const start = Date.now();
    const pid = this.processLifecycle!.getCurrentPid();
    const startTime = await this.processLifecycle!.getCurrentProcessStartTime();

    while (true) {
      let acquired = false;
      let shouldRetry = false;

      await updateState(async (state) => {
        const currentOwner = state.gpuOwner;

        // 1. Check if no one owns it
        if (!currentOwner) {
          state.gpuOwner = { pid, startTime: startTime ?? undefined, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }

        // 2. Check for re-entrancy (same PID and same process start time)
        if (currentOwner.pid === pid && currentOwner.startTime === (startTime ?? undefined)) {
          state.gpuOwner = { ...currentOwner, startedAt: Date.now(), sessionId: sessionId || currentOwner.sessionId };
          acquired = true;
          return state;
        }

        // 3. Check if owner is dead
        const isAlive = await this.processLifecycle!.isProcessAlive(currentOwner.pid, currentOwner.startTime);
        if (!isAlive) {
          logger.warn(`[GPUResourceService] Reclaiming GPU lock from dead process ${currentOwner.pid}`);
          state.gpuOwner = { pid, startTime: startTime ?? undefined, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }

        // 4. Check if lock is stale
        const age = Date.now() - currentOwner.startedAt;
        if (age > this.gpuLockStaleThresholdMs) {
          logger.warn(`[GPUResourceService] Reclaiming stale GPU lock from process ${currentOwner.pid} (age: ${age}ms)`);
          state.gpuOwner = { pid, startTime: startTime ?? undefined, startedAt: Date.now(), sessionId };
          acquired = true;
          return state;
        }

        // 5. Still held by another live process
        if (timeoutMs && Date.now() - start < timeoutMs) {
          shouldRetry = true;
        }
        return state;
      });

      if (acquired) return true;
      if (!shouldRetry) return false;

      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /**
   * Acquire the global GPU lock
   */
  async acquireGpuLock(sessionId?: string | ((updater: any) => Promise<any>), timeoutMs?: number | string, ctx?: any): Promise<boolean> {
    // Check if we are being called by StateManager (sessionId is actually updateState function)
    if (typeof sessionId === 'function') {
      const updateState = sessionId as any;
      const actualSessionId = timeoutMs as any as string;
      const actualTimeoutMs = ctx as any as number;
      return this.performAcquireGpuLock(updateState, actualSessionId, actualTimeoutMs);
    }

    // Public service interface: delegate to StateManager
    const container = tryGetServiceContainerFromCtx(ctx);
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, ctx, container);
    return stateManager.acquireGpuLock(sessionId as string | undefined, timeoutMs as number | undefined);
  }

  /**
   * Release the global GPU lock
   */
  async releaseGpuLock(pid?: number | ((updater: any) => Promise<any>), ctx?: any): Promise<void> {
    // Check if we are being called by StateManager (pid is actually updateState function)
    if (typeof pid === 'function') {
      const updateState = pid as any;
      const actualPid = ctx as any as number;
      const targetPid = actualPid || this.processLifecycle!.getCurrentPid();

      await updateState(async (state: any) => {
        if (state.gpuOwner && state.gpuOwner.pid === targetPid) {
          delete state.gpuOwner;
        }
        return state;
      });
      return;
    }

    // Public service interface: delegate to StateManager
    const container = tryGetServiceContainerFromCtx(ctx);
    const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, ctx, container);
    return stateManager.releaseGpuLock(pid as number | undefined);
  }
}
