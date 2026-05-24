/**
 * Scheduler Factory Implementation
 *
 * Implements the ISchedulerFactory interface for creating scheduler instances.
 * This module lives in the Infrastructure layer and provides concrete implementations
 * of scheduler creation logic.
 *
 * This delegates to the actual scheduler factory in browser/scheduler-factory.ts
 * to maintain backward compatibility.
 */

import type { Config } from '../config.ts';
import { logger } from '../logger.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import type { IService } from '../core/service-registry.ts';
import type { ISchedulerFactory, IScheduler } from '../core/scheduler-factory.ts';
import { getScheduler as _getScheduler } from './browser/scheduler-factory.ts';
import { getSchedulerVersion as _getSchedulerVersion } from './browser/browser-configuration.ts';
import { forceSchedulerRestart as _forceSchedulerRestart } from './browser/scheduler-factory.ts';

/**
 * Scheduler Factory Implementation
 *
 * Provides concrete implementations of scheduler creation methods.
 * Delegates to the existing browser/scheduler-factory module.
 */
export class SchedulerFactoryImpl implements ISchedulerFactory, IService {
  readonly name = 'scheduler-factory';
  lifecycle = ServiceLifecycle.INITIALIZED;

  /**
   * Get or create a scheduler instance.
   * Handles leader election and client/server mode switching.
   */
  async getScheduler(config?: Config): Promise<IScheduler> {
    return _getScheduler(config);
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
    return _forceSchedulerRestart(forceClearRemoteState);
  }
}

/**
 * Get the singleton SchedulerFactoryImpl instance
 */
let _schedulerFactoryInstance: SchedulerFactoryImpl | null = null;

export function getSchedulerFactory(): SchedulerFactoryImpl {
  if (!_schedulerFactoryInstance) {
    _schedulerFactoryInstance = new SchedulerFactoryImpl();
    logger.debug('[SchedulerFactory] Created singleton scheduler factory instance');
  }
  return _schedulerFactoryInstance;
}