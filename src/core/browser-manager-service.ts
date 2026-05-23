/**
 * Browser Manager Service
 *
 * This service manages the browser scheduler lifecycle and provides
 * a centralized interface for browser operations.
 * It replaces the global __PI_RESEARCH_SCHEDULER__ variable.
 */

import type {
  IScheduler,
  IBrowserManagerService,
  SchedulerMetadata,
} from './service-interfaces.ts';
import { ServiceLifecycle } from './service-registry.ts';
import { logger } from '../logger.ts';
import type { Config } from '../config.ts';

/**
 * BrowserManagerService implementation
 */
export class BrowserManagerService implements IBrowserManagerService {
  readonly name = 'browser-manager';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private _scheduler: IScheduler | null = null;
  private _schedulerVersion: string | null = null;
  private _initializationPromise: Promise<IScheduler> | null = null;

  // Metadata about the current scheduler
  private _schedulerMetadata: SchedulerMetadata | null = null;

  // Prevent concurrent restarts
  private _isRestartInProgress = false;

  async initialize(): Promise<void> {
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[BrowserManagerService] Initialized');
  }

  async dispose(): Promise<void> {
    // Shutdown scheduler if present
    if (this._scheduler) {
      try {
        await this._scheduler.shutdown();
      } catch (err) {
        logger.warn('[BrowserManagerService] Error during scheduler shutdown:', err);
      }
      this._scheduler = null;
    }

    this._schedulerVersion = null;
    this._initializationPromise = null;
    this._schedulerMetadata = null;
    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[BrowserManagerService] Disposed');
  }

  /**
   * Get or create the scheduler
   * This is the main entry point for scheduler access
   */
  async getScheduler(_config?: Config): Promise<IScheduler> {
    // Import dynamically to avoid circular dependency
    const { getSchedulerInstance } = await import('./internal-state.ts');
    return getSchedulerInstance() as IScheduler;
  }

  /**
   * Get the current scheduler version
   */
  getSchedulerVersion(_config?: Config): string {
    // Import dynamically to avoid circular dependency
    // Note: This sync method imports async - simplified for compatibility
    try {
      const { getSchedulerVersionState } = require('./internal-state.ts');
      return getSchedulerVersionState() || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Force a scheduler restart
   */
  async forceRestart(_forceClearRemoteState: boolean = false): Promise<void> {
    if (this._isRestartInProgress) {
      logger.log('[BrowserManagerService] Restart already in progress, skipping concurrent call.');
      return;
    }

    this._isRestartInProgress = true;
    try {
      logger.log('[BrowserManagerService] Forcing scheduler restart...');

      // Use internal state management to trigger restart
      const { setSchedulerRestartInProgress } = await import('./internal-state.ts');
      setSchedulerRestartInProgress(true);

      // Clear local state
      this._scheduler = null;
      this._schedulerVersion = null;
      this._initializationPromise = null;
      this._schedulerMetadata = null;

      logger.log('[BrowserManagerService] Restart complete.');
    } finally {
      const { setSchedulerRestartInProgress } = await import('./internal-state.ts');
      setSchedulerRestartInProgress(false);
      this._isRestartInProgress = false;
    }
  }

  /**
   * Check if the browser is available
   */
  isBrowserAvailable(): boolean {
    // Import dynamically to avoid circular dependency
    try {
      const { isBrowserAvailable: isBrowserAvailableImpl } = require('../infrastructure/browser-manager.ts');
      return isBrowserAvailableImpl();
    } catch {
      return false;
    }
  }

  /**
   * Run a browser task
   */
  async runTask<T>(
    _task: any,
    _type: 'search' | 'scrape',
    _config?: Config,
    _retries: number = 1
  ): Promise<T> {
    // This would delegate to the actual browser manager implementation
    // For now, throw as not implemented in service layer
    throw new Error('BrowserManagerService.runTask not yet implemented - use browser-manager directly');
  }

  /**
   * Run a health check
   */
  async runHealthCheck(_config?: Config, _retries: number = 1): Promise<{ success: boolean }> {
    // This would delegate to the actual browser manager implementation
    // For now, throw as not implemented in service layer
    throw new Error('BrowserManagerService.runHealthCheck not yet implemented - use browser-manager directly');
  }

  /**
   * Stop the browser manager
   */
  async stop(): Promise<void> {
    // This would delegate to the actual browser manager implementation
    // For now, throw as not implemented in service layer
    throw new Error('BrowserManagerService.stop not yet implemented - use browser-manager directly');
  }

  /**
   * Get the current scheduler (synchronous, may return null)
   */
  getCurrentScheduler(): IScheduler | null {
    return this._scheduler;
  }

  /**
   * Set the current scheduler (internal use)
   */
  setCurrentScheduler(scheduler: IScheduler | null): void {
    this._scheduler = scheduler;
  }

  /**
   * Get the current scheduler version
   */
  getCurrentSchedulerVersion(): string | null {
    return this._schedulerVersion;
  }

  /**
   * Set the current scheduler version (internal use)
   */
  setCurrentSchedulerVersion(version: string | null): void {
    this._schedulerVersion = version;
  }

  /**
   * Get the scheduler metadata
   */
  getSchedulerMetadata(): SchedulerMetadata | null {
    return this._schedulerMetadata;
  }

  /**
   * Set the scheduler metadata (internal use)
   */
  setSchedulerMetadata(metadata: SchedulerMetadata | null): void {
    this._schedulerMetadata = metadata;
  }

  /**
   * Check if a restart is in progress
   */
  isRestartInProgress(): boolean {
    return this._isRestartInProgress;
  }

  /**
   * Get the initialization promise (internal use)
   */
  getInitializationPromise(): Promise<IScheduler> | null {
    return this._initializationPromise;
  }

  /**
   * Set the initialization promise (internal use)
   */
  setInitializationPromise(promise: Promise<IScheduler> | null): void {
    this._initializationPromise = promise;
  }
}

// ============================================================================
// Singleton Accessor (for backward compatibility)
// ============================================================================

let _browserManagerServiceInstance: BrowserManagerService | null = null;

/**
 * Get or create the browser manager service instance
 */
export function getBrowserManagerService(): BrowserManagerService {
  if (!_browserManagerServiceInstance) {
    _browserManagerServiceInstance = new BrowserManagerService();
    _browserManagerServiceInstance.initialize().catch(err => {
      logger.error('[BrowserManagerService] Failed to initialize:', err);
    });
  }
  return _browserManagerServiceInstance;
}

/**
 * Reset the browser manager service instance
 * Primarily used for testing
 */
export function resetBrowserManagerService(): void {
  if (_browserManagerServiceInstance) {
    _browserManagerServiceInstance.dispose().catch(err => {
      logger.error('[BrowserManagerService] Failed to dispose:', err);
    });
  }
  _browserManagerServiceInstance = null;
}