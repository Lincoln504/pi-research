/**
 * Scheduler Service
 *
 * Coordinates the multi-process browser worker pool and task scheduling.
 * Implements leader election to ensure only one browser pool is active.
 */

import { ServiceLifecycle, getService, tryGetServiceContainerFromCtx } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import type { IScheduler, ISchedulerFactory, ISchedulerService, ISchedulerInternals, ISchedulerInstance } from './service-interfaces.ts';
import { logger } from '../logger.ts';
import type { Config } from '../config.ts';

/**
 * Scheduler Service Implementation
 */
export class SchedulerService implements ISchedulerService, ISchedulerInternals {
  readonly name = ServiceNames.SCHEDULER;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private scheduler: IScheduler | null = null;
  private initializationPromise: Promise<IScheduler> | null = null;
  private schedulerVersion: string | null = null;
  private pendingShutdownPromise: Promise<void> | null = null;
  private restartInProgress = false;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) return;
    this.lifecycle = ServiceLifecycle.DISPOSING;
    
    if (this.scheduler) {
      try {
        await this.scheduler.shutdown();
      } catch (err) {
        logger.error('[SchedulerService] Error during scheduler shutdown:', err);
      }
      this.scheduler = null;
    }
    
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Ensure a scheduler is available for research
   * This implements the leader election / connection logic
   */
  async ensureScheduler(config?: Config, ctx?: any): Promise<IScheduler> {
    if (this.scheduler) return this.scheduler;
    if (this.initializationPromise) return this.initializationPromise;

    const container = tryGetServiceContainerFromCtx(ctx);

    this.initializationPromise = (async () => {
      try {
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY, ctx, container);
        const scheduler = await factory.getScheduler(config);
        this.scheduler = scheduler;
        return scheduler;
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Get the current scheduler instance if initialized
   */
  getScheduler(): IScheduler | null {
    return this.scheduler;
  }

  /**
   * Check if the scheduler is ready
   */
  isReady(): boolean {
    return this.scheduler !== null;
  }

  // ============================================================================
  // ISchedulerInternals Implementation
  // ============================================================================

  getSchedulerInstance(): ISchedulerInstance | null {
    return this.scheduler as unknown as ISchedulerInstance | null;
  }

  setSchedulerInstance(instance: ISchedulerInstance | null): void {
    this.scheduler = instance as unknown as IScheduler | null;
  }

  getSchedulerVersion(): string | null {
    return this.schedulerVersion;
  }

  setSchedulerVersion(version: string | null): void {
    this.schedulerVersion = version;
  }

  getSchedulerInitializationPromise(): Promise<ISchedulerInstance> | null {
    return this.initializationPromise as unknown as Promise<ISchedulerInstance> | null;
  }

  setSchedulerInitializationPromise(promise: Promise<ISchedulerInstance> | null): void {
    this.initializationPromise = promise as unknown as Promise<IScheduler> | null;
  }

  getPendingShutdownPromise(): Promise<void> | null {
    return this.pendingShutdownPromise;
  }

  setPendingShutdownPromise(promise: Promise<void> | null): void {
    this.pendingShutdownPromise = promise;
  }

  isSchedulerRestartInProgress(): boolean {
    return this.restartInProgress;
  }

  setSchedulerRestartInProgress(inProgress: boolean): void {
    this.restartInProgress = inProgress;
  }
}
