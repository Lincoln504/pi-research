/**
 * State Manager Service
 *
 * Service wrapper for the shared state manager functionality.
 * Provides clean interface for cross-process state management.
 */

import { ServiceLifecycle, getService, tryGetServiceContainerFromCtx } from '../../core/service-registry.ts';
import { logger } from '../../logger.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { IStateManager, IProcessLifecycle } from '../../core/service-interfaces.ts';
import type {
  StateMetrics,
  SingletonState,
} from './state-manager.ts';
import type { GPUResourceService } from '../gpu-resource-service.ts';
import type { StateSessionManager } from './state-session-manager.ts';
import type { StateBrowserManager } from './state-browser-manager.ts';
import type { StateMetricsCollector } from './state-metrics.ts';
import type { StateValidator } from './state-validator.ts';
import type { FileLockService } from '../file-lock-service.ts';
import type { StateBackupManager } from './state-backup-manager.ts';
import type { StatePathConfiguration } from './state-path-configuration.ts';

// Import the actual state manager implementation (static import)
import { StateManager } from './state-manager.ts';

/**
 * State Manager Service Implementation
 */
export class StateManagerService implements IStateManager {
  readonly name = ServiceNames.STATE_MANAGER;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // The underlying state manager instance
  private _stateManager: StateManager | null = null;

  async initialize(ctx?: any): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[StateManagerService] Initializing...');

    const container = tryGetServiceContainerFromCtx(ctx);

    // Resolve all dependencies using the container for isolation
    const processLifecycle = await getService<IProcessLifecycle>(ServiceNames.PROCESS_LIFECYCLE, ctx, container);
    const fileLockService = await getService<FileLockService>(ServiceNames.FILE_LOCK_SERVICE, ctx, container);
    const backupManager = await getService<StateBackupManager>(ServiceNames.STATE_BACKUP_MANAGER, ctx, container);
    const gpuResourceService = await getService<GPUResourceService>(ServiceNames.GPU_RESOURCE_SERVICE, ctx, container);
    const sessionManager = await getService<StateSessionManager>(ServiceNames.STATE_SESSION_MANAGER, ctx, container);
    const browserManager = await getService<StateBrowserManager>(ServiceNames.STATE_BROWSER_MANAGER, ctx, container);
    const metricsCollector = await getService<StateMetricsCollector>(ServiceNames.STATE_METRICS_COLLECTOR, ctx, container);
    const validator = await getService<StateValidator>(ServiceNames.STATE_VALIDATOR, ctx, container);

    // Resolve the state directory from StatePathConfiguration
    const pathConfig = await getService<StatePathConfiguration>(ServiceNames.STATE_PATH_CONFIGURATION, ctx, container);
    const stateDir = pathConfig.getStateDir();

    // Instantiate state manager with injected dependencies
    this._stateManager = new StateManager({
      stateDir,
      processLifecycle,
      fileLockService,
      backupManager,
      gpuResourceService,
      sessionManager,
      browserManager,
      metricsCollector,
      validator,
    });

    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.debug('[StateManagerService] Initialized');
  }

  async dispose(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.DISPOSED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.DISPOSING;
    logger.debug('[StateManagerService] Disposing...');

    // Cleanup state manager resources
    if (this._stateManager) {
      try {
        await this._stateManager.cleanup();
      } catch (err) {
        logger.warn('[StateManagerService] Error during cleanup:', err);
      }
      this._stateManager = null;
    }

    this.lifecycle = ServiceLifecycle.DISPOSED;
    logger.debug('[StateManagerService] Disposed');
  }

  /**
   * Get the underlying state manager instance
   */
  getStateManager(): StateManager {
    if (!this._stateManager) {
      throw new Error('[StateManagerService] State manager not initialized');
    }
    return this._stateManager;
  }

  /**
   * Read the state from the file system
   */
  async readState(): Promise<SingletonState> {
    return this.getStateManager().readState();
  }

  /**
   * Write the state to the file system
   */
  async writeState(state: SingletonState): Promise<void> {
    return this.getStateManager().writeState(state);
  }

  /**
   * Update state atomically using an updater function
   */
  async updateState(updater: (state: SingletonState) => SingletonState | Promise<SingletonState>): Promise<void> {
    return this.getStateManager().updateState(updater);
  }

  /**
   * Add a new session to the state
   */
  async addSession(sessionId: string, param: number | string): Promise<void> {
    return this.getStateManager().addSession(sessionId, param);
  }

  /**
   * Remove a session from the state
   */
  async removeSession(sessionId: string): Promise<void> {
    return this.getStateManager().removeSession(sessionId);
  }

  /**
   * Update the heartbeat timestamp for a session
   */
  async updateHeartbeat(sessionId: string): Promise<void> {
    return this.getStateManager().updateHeartbeat(sessionId);
  }

  /**
   * Clean up stale sessions
   */
  async cleanupStaleSessions(timeoutMs: number): Promise<number> {
    return this.getStateManager().cleanupStaleSessions(timeoutMs);
  }

  /**
   * Get metrics about the current state
   */
  async getMetrics(): Promise<StateMetrics> {
    return this.getStateManager().getMetrics();
  }

  /**
   * Get the current browser server information
   */
  async getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string; authSecret?: string } | null> {
    // Read-only query. When the state manager was never initialized — common for a
    // run that never registered a browser server (e.g. KNOWLEDGE_STORE_MODE='none',
    // or an early failure before browser startup) — there is simply nothing
    // recorded. Return null instead of throwing so shutdown paths that probe for a
    // browser server (scheduler.shutdown) degrade quietly rather than logging a
    // misleading "State manager not initialized" error.
    if (!this._stateManager) return null;
    return this.getStateManager().getBrowserServer();
  }

  /**
   * Set the current browser server information
   */
  async setBrowserServer(port: number, pid: number, schedulerId?: string, authSecret?: string): Promise<void> {
    return this.getStateManager().setBrowserServer(port, pid, schedulerId, authSecret);
  }

  /**
   * Clear the browser server information
   */
  async clearBrowserServer(): Promise<void> {
    return this.getStateManager().clearBrowserServer();
  }

  /**
   * Get the current embedding server information
   */
  async getEmbeddingServer(): Promise<{ port: number; pid: number; startTime?: number; serverId: string; model?: string; authSecret?: string } | null> {
    return this.getStateManager().getEmbeddingServer();
  }

  /**
   * Clear the embedding server information
   */
  async clearEmbeddingServer(): Promise<void> {
    return this.getStateManager().clearEmbeddingServer();
  }

  /**
   * Check if a process is alive
   */
  async isPidAlive(pid: number, expectedSchedulerId?: string, skipLock?: boolean): Promise<boolean> {
    return this.getStateManager().isPidAlive(pid, expectedSchedulerId, skipLock);
  }

  /**
   * Acquire the global GPU resource lock
   */
  async acquireGpuLock(sessionId?: string, timeoutMs?: number): Promise<boolean> {
    return this.getStateManager().acquireGpuLock(sessionId, timeoutMs);
  }

  /**
   * Release the global GPU resource lock
   */
  async releaseGpuLock(pid?: number): Promise<void> {
    return this.getStateManager().releaseGpuLock(pid);
  }

  /**
   * Information about the current GPU owner
   */
  async getGpuOwner(): Promise<SingletonState['gpuOwner'] | null> {
    return this.getStateManager().getGpuOwner();
  }

  /**
   * Cleanup state manager resources
   */
  async cleanup(): Promise<void> {
    return this.getStateManager().cleanup();
  }

  /**
   * Get the state file path
   */
  getStateFilePath(): string {
    return this.getStateManager().getStateFilePath();
  }

  /**
   * Get the lock file path
   */
  getLockFilePath(): string {
    return this.getStateManager().getLockFilePath();
  }

  /**
   * Get the backup directory path
   */
  getBackupDirPath(): string {
    return this.getStateManager().getBackupDirPath();
  }
}
