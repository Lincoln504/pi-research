/**
 * Scheduler Factory Interface
 *
 * Defines the contract for creating scheduler instances.
 * This interface lives in the Core layer to follow Clean Architecture principles.
 *
 * Implementations should be provided by the Infrastructure layer.
 */

import type { Config } from '../config.ts';
import type { IService } from './service-registry.ts';
import type { IScheduler } from './interfaces/scheduler-interfaces.ts';
export type { IScheduler };

/**
 * Scheduler Factory Interface
 *
 * Provides methods for creating and managing scheduler instances.
 * This interface allows the Core layer to depend on abstractions,
 * not concrete implementations from the Infrastructure layer.
 */
export interface ISchedulerFactory extends IService {
  /**
   * Get or create a scheduler instance.
   * Handles leader election and client/server mode switching.
   *
   * @param config Optional configuration
   * @returns A scheduler instance
   */
  getScheduler(config?: Config): Promise<IScheduler>;

  /**
   * Get the current scheduler version string.
   * The version is derived from the configuration and changes when config changes.
   *
   * @param config Optional configuration
   * @returns The scheduler version string
   */
  getSchedulerVersion(config?: Config): string;

  /**
   * Force a restart of the scheduler by clearing the global cache and state.
   * This should be called when configuration changes are detected.
   *
   * @param forceClearRemoteState Whether to force clear state from remote processes
   */
  forceSchedulerRestart(forceClearRemoteState?: boolean): Promise<void>;
}