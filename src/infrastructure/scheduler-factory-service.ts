/**
 * Scheduler Factory Service
 *
 * Implements the ISchedulerFactory interface for creating scheduler instances.
 * This module lives in the Infrastructure layer and provides concrete implementations
 * of scheduler creation logic.
 */

import type { Config } from '../config.ts';
import { ServiceLifecycle, getServiceContainer, type ServiceContainer } from '../core/service-registry.ts';
import type { IService } from '../core/service-registry.ts';
import type { ISchedulerFactory, IScheduler } from '../core/scheduler-factory.ts';
import { getScheduler as _getScheduler, forceSchedulerRestart as _forceSchedulerRestart, disposeBrowserInitLock } from './browser/scheduler-factory.ts';
import { getSchedulerVersion as _getSchedulerVersion } from './browser/config.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

/**
 * Scheduler Factory Service Implementation
 */
export class SchedulerFactoryService implements ISchedulerFactory, IService {
  readonly name = ServiceNames.SCHEDULER_FACTORY;
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  private container: ServiceContainer = getServiceContainer();

  async initialize(ctx?: any): Promise<void> {
    if (ctx?.container) {
      this.container = ctx.container;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    await disposeBrowserInitLock(this.container);
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Get or create a scheduler instance.
   * Handles leader election and client/server mode switching.
   */
  async getScheduler(config?: Config): Promise<IScheduler> {
    return _getScheduler(config, this.container);
  }

  /**
   * Get the current scheduler version string.
   */
  getSchedulerVersion(config?: Config): string {
    return _getSchedulerVersion(config);
  }

  /**
   * Force a restart of the scheduler by clearing the global cache and state.
   */
  async forceSchedulerRestart(forceClearRemoteState?: boolean): Promise<void> {
    return _forceSchedulerRestart(forceClearRemoteState, this.container);
  }
}
