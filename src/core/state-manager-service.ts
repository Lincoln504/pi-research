/**
 * State Manager Service
 *
 * Service wrapper for the shared state manager functionality.
 * Provides clean interface for cross-process state management.
 */

import { ServiceLifecycle } from './service-registry.ts';
import { logger } from '../logger.ts';
import type { IStateManager } from './service-interfaces.ts';
import type {
  StateMetrics,
  LegacySessionInfo,
  SingletonState,
} from '../infrastructure/state-manager.ts';

// Import the actual state manager implementation (static import)
import { StateManager, getSharedStateManager as getSharedStateManagerImpl } from '../infrastructure/state-manager.ts';

/**
 * State Manager Service Implementation
 */
export class StateManagerService implements IStateManager {
  readonly name = 'state-manager';
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  // The underlying state manager instance
  private _stateManager: StateManager | null = null;

  async initialize(): Promise<void> {
    if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
      return;
    }

    this.lifecycle = ServiceLifecycle.INITIALIZING;
    logger.debug('[StateManagerService] Initializing...');

    // Get the shared state manager instance
    this._stateManager = getSharedStateManagerImpl();

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
  async getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string } | null> {
    return this.getStateManager().getBrowserServer();
  }

  /**
   * Set the current browser server information
   */
  async setBrowserServer(port: number, pid: number, schedulerId?: string): Promise<void> {
    return this.getStateManager().setBrowserServer(port, pid, schedulerId);
  }

  /**
   * Clear the browser server information
   */
  async clearBrowserServer(): Promise<void> {
    return this.getStateManager().clearBrowserServer();
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
   * Get information about the current GPU owner
   */
  async getGpuOwner(): Promise<SingletonState['gpuOwner'] | null> {
    return this.getStateManager().getGpuOwner();
  }

  // Backward compatibility methods

  /**
   * Get a session by ID (backward compatible)
   */
  async getSession(sessionId: string): Promise<LegacySessionInfo | null> {
    return this.getStateManager().getSession(sessionId);
  }

  /**
   * Update the activity timestamp for a session (backward compatible)
   */
  async updateActivity(sessionId: string): Promise<void> {
    return this.getStateManager().updateActivity(sessionId);
  }

  /**
   * Get all sessions (backward compatible)
   */
  async getAllSessions(): Promise<{ [sessionId: string]: LegacySessionInfo }> {
    return this.getStateManager().getAllSessions();
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

// ============================================================================
// Singleton Accessor (for backward compatibility)
// ============================================================================

let _stateManagerServiceInstance: StateManagerService | null = null;

/**
 * Get or create the state manager service instance
 */
export function getStateManagerService(): StateManagerService {
  if (!_stateManagerServiceInstance) {
    _stateManagerServiceInstance = new StateManagerService();
    _stateManagerServiceInstance.initialize().catch(err => {
      logger.error('[StateManagerService] Failed to initialize:', err);
    });
  }
  return _stateManagerServiceInstance;
}

/**
 * Reset the state manager service instance
 * Primarily used for testing
 */
export function resetStateManagerService(): void {
  if (_stateManagerServiceInstance) {
    _stateManagerServiceInstance.dispose().catch(err => {
      logger.error('[StateManagerService] Failed to dispose:', err);
    });
  }
  _stateManagerServiceInstance = null;
}

/**
 * Get the shared state manager (backward compatibility)
 * This function delegates to the service
 */
export function getSharedStateManager(): StateManager {
  const service = getStateManagerService();
  return service.getStateManager();
}