/**
 * Scheduler Service
 *
 * Coordinates the multi-process browser worker pool and task scheduling.
 * Implements leader election to ensure only one browser pool is active.
 */

import { ServiceLifecycle } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import type { IScheduler, ISchedulerService, ISchedulerInternals, ISchedulerInstance } from './service-interfaces.ts';
import { logger } from '../logger.ts';
import { raceWithDeadline } from '../utils/safe-unref.ts';

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

    // Invalidate any in-flight initialization FIRST: the scheduler factory
    // re-checks this slot (its "superseded" guard) after every await point,
    // so nulling it here makes a mid-election init shut down its
    // freshly-created scheduler (closing its HTTP server) instead of
    // installing it onto a disposed service where nothing would ever tear it
    // down. Then await the in-flight init (bounded — the election can block
    // up to ~60s on the browser-init lock) so its product is torn down
    // before we report disposal complete. The expected outcome is a
    // rejection ("Initialization superseded"); swallow it.
    const inFlightInit = this.initializationPromise;
    this.initializationPromise = null;
    if (inFlightInit) {
      try {
        await raceWithDeadline(inFlightInit.then(() => undefined, () => undefined), 10000);
      } catch {
        /* raceWithDeadline only rejects if the promise rejects; already swallowed above */
      }
    }

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
