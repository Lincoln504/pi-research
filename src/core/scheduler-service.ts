/**
 * Scheduler Service
 *
 * Service wrapper for the browser scheduler functionality.
 * Provides a clean interface for browser operations (search, scrape, health check)
 * and manages the scheduler lifecycle properly.
 *
 * All state is managed within the singleton instance, accessed via getSchedulerService().
 */

import type { SearchResult } from './service-interfaces.ts';
import type { IScheduler } from './scheduler-factory.ts';
import type { ISchedulerFactory } from './scheduler-factory.ts';
import { ServiceLifecycle } from './service-registry.ts';
import { getService } from './service-registry.ts';
import { ServiceNames } from './service-interfaces.ts';
import { logger } from '../logger.ts';
import type { Config } from '../config.ts';
import type { IService } from './service-registry.ts';



// ============================================================================
// Scheduler Instance Interface (minimal to avoid circular dependencies)
// ============================================================================

/**
 * Scheduler instance interface (minimal to avoid circular dependencies)
 */
export interface ISchedulerInstance {
  shutdown(): Promise<void>;
  schedulerId?: string;
  [key: string]: any;
}

// ============================================================================
// Singleton Scheduler Service Instance
// ============================================================================

let _schedulerServiceInstance: SchedulerService | null = null;

/**
 * Get the singleton SchedulerService instance
 * This is the only way to access the scheduler service across the application
 */
export function getSchedulerService(): SchedulerService {
  if (!_schedulerServiceInstance) {
    _schedulerServiceInstance = new SchedulerService();
  }
  return _schedulerServiceInstance;
}

// ============================================================================
// Scheduler Service Implementation
// ============================================================================

// Internal scheduler type - matches the actual implementation
interface ISchedulerInternal {
  name?: string;
  lifecycle?: ServiceLifecycle;
  runSearch?: (query: string, config?: Config) => Promise<SearchResult[]>;
  runScrape?: (url: string, config?: Config) => Promise<unknown>;
  runHealthCheck?: (config?: Config) => Promise<{ success: boolean }>;
  schedulerId?: string;
  shutdown?: () => Promise<void>;
  resetIdleTimerOnActivity?: () => void;
}

/**
 * Scheduler Service Implementation
 * Wraps the browser scheduler with proper service lifecycle management
 * All state is managed within the instance - no module-level state
 */
export class SchedulerService implements IService, IScheduler {
  readonly name = 'scheduler';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // ==========================================================================
  // INSTANCE STATE - All state is instance-level, no module-level state
  // ==========================================================================

  // Internal scheduler instance (either BrowserTaskScheduler or BrowserClient)
  private _scheduler: ISchedulerInternal | null = null;
  
  // Scheduler metadata
  private _metadata: {
    schedulerId: string;
    schedulerVersion: string;
    port?: number;
    pid: number;
    isLeader: boolean;
  } | null = null;

  // Initialization lock
  private _initializationLock: Promise<IScheduler> | null = null;

  // Shared scheduler state (for cross-module access)
  // This replaces the module-level _internalState
  private _sharedState: {
    schedulerInstance: ISchedulerInstance | null;
    schedulerVersion: string | null;
    initializationPromise: Promise<ISchedulerInstance> | null;
    isRestartInProgress: boolean;
  } = {
    schedulerInstance: null,
    schedulerVersion: null,
    initializationPromise: null,
    isRestartInProgress: false,
  };

  // ==========================================================================
  // Service Lifecycle Methods
  // ==========================================================================

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[SchedulerService] Initializing...');

    // Don't eagerly create the scheduler - it will be created on first use
    // This allows configuration to be loaded first

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[SchedulerService] Initialized (scheduler will be created on first use)');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[SchedulerService] Disposing...');

    // Shutdown the scheduler if it exists
    if (this._scheduler?.shutdown) {
      try {
        await this._scheduler.shutdown();
        logger.debug('[SchedulerService] Scheduler shutdown complete');
      } catch (err) {
        logger.warn('[SchedulerService] Error during scheduler shutdown:', err);
      }
      this._scheduler = null;
    }

    // Clear shared state
    this._sharedState = {
      schedulerInstance: null,
      schedulerVersion: null,
      initializationPromise: null,
      isRestartInProgress: false,
    };

    this._metadata = null;
    this._initializationLock = null;

    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[SchedulerService] Disposed');
  }

  // ==========================================================================
  // State Management Methods (Instance Methods - No Module-Level State)
  // ==========================================================================

  /**
   * Get the current scheduler instance
   */
  getSchedulerInstance(): ISchedulerInstance | null {
    return this._sharedState.schedulerInstance;
  }

  /**
   * Set the scheduler instance
   */
  setSchedulerInstance(scheduler: ISchedulerInstance | null): void {
    this._sharedState.schedulerInstance = scheduler;
  }

  /**
   * Get the scheduler version
   */
  getSchedulerVersion(): string | null {
    return this._sharedState.schedulerVersion;
  }

  /**
   * Set the scheduler version
   */
  setSchedulerVersion(version: string | null): void {
    this._sharedState.schedulerVersion = version;
  }

  /**
   * Get the scheduler initialization promise
   */
  getSchedulerInitializationPromise(): Promise<ISchedulerInstance> | null {
    return this._sharedState.initializationPromise;
  }

  /**
   * Set the scheduler initialization promise
   */
  setSchedulerInitializationPromise(promise: Promise<ISchedulerInstance> | null): void {
    this._sharedState.initializationPromise = promise;
  }

  /**
   * Check if a scheduler restart is in progress
   */
  isSchedulerRestartInProgress(): boolean {
    return this._sharedState.isRestartInProgress;
  }

  /**
   * Set the scheduler restart in progress state
   */
  setSchedulerRestartInProgress(inProgress: boolean): void {
    this._sharedState.isRestartInProgress = inProgress;
  }

  /**
   * Clear all scheduler state
   */
  clearSchedulerState(): void {
    this._sharedState.schedulerInstance = null;
    this._sharedState.schedulerVersion = null;
    this._sharedState.initializationPromise = null;
    this._sharedState.isRestartInProgress = false;
  }

  // ==========================================================================
  // Scheduler Operations
  // ==========================================================================

  /**
   * Get or create the scheduler instance
   * This is the main entry point for scheduler access
   */
  private async getOrCreateScheduler(config?: Config): Promise<IScheduler> {
    // Return existing scheduler if already initialized
    if (this._scheduler) {
      return this as unknown as IScheduler;
    }

    // Return existing initialization promise if in progress
    if (this._initializationLock) {
      return this._initializationLock as Promise<IScheduler>;
    }

    // Create a new initialization lock
    const initPromise = (async () => {
      try {
        // Get the scheduler factory from the service registry
        // The factory is registered by infrastructure initialization
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY);
        
        const scheduler = await factory.getScheduler(config);
        
        // Store the scheduler instance
        this._scheduler = scheduler as unknown as ISchedulerInternal;
        
        // Update metadata
        const schedulerVersion = factory.getSchedulerVersion(config);
        const schedulerId = this._scheduler.schedulerId || 'client';
        const isLeader = schedulerId !== 'client';

        this._metadata = {
          schedulerId,
          schedulerVersion,
          pid: process.pid,
          isLeader,
        };

        logger.debug('[SchedulerService] Scheduler created:', this._metadata);
        return this as unknown as IScheduler;
      } finally {
        // Clear the initialization lock
        this._initializationLock = null;
      }
    })();

    this._initializationLock = initPromise;
    return initPromise as Promise<IScheduler>;
  }

  /**
   * Run a search query
   */
  async runSearch(query: string, config?: Config): Promise<SearchResult[]> {
    await this.getOrCreateScheduler(config);
    if (!this._scheduler?.runSearch) {
      throw new Error('Scheduler does not support runSearch');
    }
    return this._scheduler.runSearch(query, config);
  }

  /**
   * Scrape a URL
   */
  async runScrape(url: string, config?: Config): Promise<unknown> {
    await this.getOrCreateScheduler(config);
    if (!this._scheduler?.runScrape) {
      throw new Error('Scheduler does not support runScrape');
    }
    return this._scheduler.runScrape(url, config);
  }

  /**
   * Run a health check
   */
  async runHealthCheck(config?: Config): Promise<{ success: boolean }> {
    await this.getOrCreateScheduler(config);
    if (!this._scheduler?.runHealthCheck) {
      return { success: false };
    }
    return this._scheduler.runHealthCheck(config);
  }

  /**
   * Shutdown the scheduler
   */
  async shutdown(): Promise<void> {
    if (this._scheduler?.shutdown) {
      await this._scheduler.shutdown();
    }
    this._scheduler = null;
    this._metadata = null;
  }

  /**
   * Reset idle timer (for scheduler instances)
   */
  resetIdleTimerOnActivity(): void {
    if (this._scheduler?.resetIdleTimerOnActivity) {
      this._scheduler.resetIdleTimerOnActivity();
    }
  }

  // ==========================================================================
  // Metadata and Query Methods
  // ==========================================================================

  /**
   * Get the scheduler metadata
   */
  getMetadata(): typeof this._metadata {
    return this._metadata;
  }

  /**
   * Check if the scheduler is initialized
   */
  isInitialized(): boolean {
    return this._scheduler !== null;
  }

  /**
   * Check if this process is the leader (has the browser pool)
   */
  isLeader(): boolean {
    return this._metadata?.isLeader ?? false;
  }

  /**
   * Get the scheduler ID
   */
  getSchedulerId(): string | null {
    return this._metadata?.schedulerId ?? null;
  }

  /**
   * Force a scheduler restart
   * Clears the current scheduler and creates a new one on next access
   */
  async forceRestart(): Promise<void> {
    logger.debug('[SchedulerService] Forcing scheduler restart...');

    // Shutdown the current scheduler
    if (this._scheduler?.shutdown) {
      try {
        await this._scheduler.shutdown();
      } catch (err) {
        logger.warn('[SchedulerService] Error during scheduler shutdown:', err);
      }
      this._scheduler = null;
    }

    // Clear metadata
    this._metadata = null;

    // Clear initialization lock
    this._initializationLock = null;

    // Clear shared state
    this.clearSchedulerState();

    logger.debug('[SchedulerService] Scheduler restart complete (will recreate on next access)');
  }
}