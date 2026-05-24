/**
 * Browser Manager Service (Refactored)
 *
 * This service manages the browser scheduler lifecycle and provides
 * a centralized interface for browser operations.
 * 
 * REFACTORED: No dynamic imports, all interface methods fully implemented.
 * Acts as a proper facade that delegates to scheduler-service.
 */

import type {
  IScheduler,
  IBrowserManagerService,
  SchedulerMetadata,
  IStateManager,
} from './service-interfaces.ts';
import { ServiceNames } from './service-interfaces.ts';
import { ServiceLifecycle, getService } from './service-registry.ts';
import { logger } from '../logger.ts';
import type { Config } from '../config.ts';
import type { SearchResult } from '../web-research/types.ts';
import { SchedulerService } from './scheduler-service.ts';

// Static imports from infrastructure
import {
  _internalGetSchedulerVersion as getBrowserSchedulerVersion,
  isBrowserAvailable,
} from '../infrastructure/browser-manager.ts';

/**
 * BrowserManagerService implementation
 * 
 * This service acts as a facade over the scheduler service, providing
 * backward compatibility with the existing browser-manager API.
 */
export class BrowserManagerService implements IBrowserManagerService {
  readonly name = 'browser-manager';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private _schedulerVersion: string | null = null;

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[BrowserManagerService] Initializing...');

    // Ensure scheduler service is initialized
    try {
      // Scheduler service is initialized lazily on first use
      await getService<IScheduler>(ServiceNames.SCHEDULER);
    } catch (err) {
      logger.warn('[BrowserManagerService] Failed to initialize scheduler service:', err);
    }

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[BrowserManagerService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[BrowserManagerService] Disposing...');

    // Scheduler service cleanup is handled by the service registry
    // We just clear our local state
    this._schedulerVersion = null;

    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[BrowserManagerService] Disposed');
  }

  /**
   * Get or create the scheduler
   * This is the main entry point for scheduler access
   */
  async getScheduler(_config?: Config): Promise<IScheduler> {
    const schedulerService = await getService<IScheduler>(ServiceNames.SCHEDULER);
    return schedulerService;
  }

  /**
   * Get the current scheduler version
   */
  getSchedulerVersion(): string {
    if (this._schedulerVersion) {
      return this._schedulerVersion;
    }

    // Use static import
    const version = getBrowserSchedulerVersion() ?? 'unknown';
    this._schedulerVersion = version;
    return version;
  }

  /**
   * Force a scheduler restart
   */
  async forceRestart(forceClearRemoteState: boolean = false): Promise<void> {
    logger.log('[BrowserManagerService] Forcing scheduler restart...');

    try {
      // Clear the cached version
      this._schedulerVersion = null;

      // Force restart via the scheduler service
      const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
      if (typeof schedulerService.forceRestart === 'function') {
        await schedulerService.forceRestart();
      }

      // If forceClearRemoteState is true, we also clear state
      if (forceClearRemoteState) {
        const stateManagerService = await getService<IStateManager>(ServiceNames.STATE_MANAGER);
        await stateManagerService.clearBrowserServer().catch((err: unknown) => {
          logger.warn('[BrowserManagerService] Failed to clear browser server state:', err);
        });
      }

      logger.log('[BrowserManagerService] Restart complete.');
    } catch (err) {
      logger.error('[BrowserManagerService] Error during scheduler restart:', err);
      throw err;
    }
  }

  /**
   * Check if the browser is available
   */
  isBrowserAvailable(): boolean {
    return isBrowserAvailable();
  }

  /**
   * Run a browser task (search or scrape)
   */
  async runTask<T>(
    task: string | { query?: string; url?: string },
    type: 'search' | 'scrape',
    config?: Config,
    _retries: number = 1
  ): Promise<T> {
    const schedulerService = await getService<IScheduler>(ServiceNames.SCHEDULER);

    if (type === 'search') {
      const query = typeof task === 'string' ? task : task.query;
      if (!query) {
        throw new Error('Search task requires a query');
      }
      return (await schedulerService.runSearch(query, config)) as T;
    } else if (type === 'scrape') {
      const url = typeof task === 'string' ? task : task.url;
      if (!url) {
        throw new Error('Scrape task requires a URL');
      }
      return (await schedulerService.runScrape(url, config)) as T;
    } else {
      throw new Error(`Unknown task type: ${type}`);
    }
  }

  /**
   * Run a health check
   */
  async runHealthCheck(config?: Config, _retries: number = 1): Promise<{ success: boolean }> {
    const schedulerService = await getService<IScheduler>(ServiceNames.SCHEDULER);
    return schedulerService.runHealthCheck(config);
  }

  /**
   * Stop the browser manager
   */
  async stop(): Promise<void> {
    logger.log('[BrowserManagerService] Stopping browser manager...');

    try {
      // Shutdown the scheduler service
      const schedulerService = await getService<IScheduler>(ServiceNames.SCHEDULER);
      await schedulerService.shutdown();

      // Clear cached version
      this._schedulerVersion = null;

      logger.log('[BrowserManagerService] Browser manager stopped.');
    } catch (err) {
      logger.error('[BrowserManagerService] Error stopping browser manager:', err);
      throw err;
    }
  }

  /**
   * Run a search (convenience method)
   */
  async runSearch(query: string, config?: Config): Promise<SearchResult[]> {
    return this.runTask<SearchResult[]>(query, 'search', config);
  }

  /**
   * Run a scrape (convenience method)
   */
  async runScrape(url: string, config?: Config): Promise<unknown> {
    return this.runTask(url, 'scrape', config);
  }

  /**
   * Get scheduler metadata (convenience method)
   */
  async getSchedulerMetadata(): Promise<SchedulerMetadata | null> {
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    if (typeof schedulerService.getMetadata === 'function') {
      return schedulerService.getMetadata();
    }
    return null;
  }

  /**
   * Check if scheduler is the leader (convenience method)
   */
  async isSchedulerLeader(): Promise<boolean> {
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    if (typeof schedulerService.isLeader === 'function') {
      return schedulerService.isLeader();
    }
    return false;
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