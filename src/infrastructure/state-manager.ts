/**
 * State Manager
 *
 * Refactored state management that delegates to specialized services.
 * Maintains backward compatibility while providing clean separation of concerns.
 *
 * This class manages:
 * - State file persistence (read/write/update)
 * - Session lifecycle management
 * - Browser server coordination
 * - Backup and recovery
 *
 * Delegates to:
 * - FileLockService for cross-process locking
 * - ProcessLifecycleService for PID checks
 * - GPUResourceService for GPU locking
 * - StateSessionManager for session operations
 * - StateBrowserManager for browser operations
 * - StateBackupManager for backup/recovery
 * - StateMetricsCollector for metrics
 * - StateValidator for validation
 * - StateSessionApi for session API
 * - StateBrowserApi for browser API
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { FileLockService } from './file-lock-service.ts';
import { ProcessLifecycleService, getSharedProcessLifecycleService } from './process-lifecycle-service.ts';
import { GPUResourceService } from './gpu-resource-service.ts';
import { StateBackupManager } from './state-backup-manager.ts';
import { StateBrowserManager } from './state-browser-manager.ts';
import { StateSessionManager } from './state-session-manager.ts';
import { StateMetricsCollector } from './state-metrics.ts';
import { StateValidator } from './state-validator.ts';
import { StateSessionApi } from './state-session-api.ts';
import { StateBrowserApi } from './state-browser-api.ts';
import type {
  StateMetrics,
  SessionInfo,
  SingletonState,
  LegacySessionInfo,
  LegacyState,
} from './types/state-types.ts';

// Re-export for backward compatibility
export type { StateMetrics, SessionInfo, SingletonState, LegacySessionInfo, LegacyState };

/**
 * StateManager class for managing singleton state with file-based storage,
 * file locking, backup system, and corruption recovery.
 */
export class StateManager {
  // Path configuration
  private readonly stateFilePath: string;
  private readonly lockDirPath: string;
  private readonly backupDirPath: string;
  private readonly lockFilePath: string;

  // Backup configuration
  private readonly maxBackups: number = 5;

  // Services
  private readonly fileLockService: FileLockService;
  private readonly processLifecycle: ProcessLifecycleService;
  private readonly gpuResourceService: GPUResourceService;
  private readonly sessionApi: StateSessionApi;
  private readonly browserApi: StateBrowserApi;
  private readonly backupManager: StateBackupManager;
  private readonly metricsCollector: StateMetricsCollector;
  private readonly validator: StateValidator;

  constructor(stateDir?: string) {
    if (!stateDir) {
      const homeDir = os.homedir();
      stateDir = path.join(homeDir, '.pi', 'state');
    }

    this.stateFilePath = path.join(stateDir, 'research-state.json');
    this.lockDirPath = path.join(stateDir, '.locks');
    this.backupDirPath = path.join(stateDir, 'backups');
    this.lockFilePath = path.join(this.lockDirPath, 'research-state.lock');

    // Initialize services
    this.fileLockService = new FileLockService({
      lockFilePath: this.lockFilePath,
    });
    this.processLifecycle = getSharedProcessLifecycleService();
    this.gpuResourceService = new GPUResourceService({
      processLifecycle: this.processLifecycle,
    });
    const sessionManager = new StateSessionManager(this.processLifecycle);
    const browserManager = new StateBrowserManager();
    this.sessionApi = new StateSessionApi(sessionManager);
    this.browserApi = new StateBrowserApi(browserManager);
    this.backupManager = new StateBackupManager(
      this.stateFilePath,
      this.backupDirPath,
      this.maxBackups
    );
    this.metricsCollector = new StateMetricsCollector();
    this.validator = new StateValidator();
  }

  /**
   * Initialize directories with proper permissions
   */
  private async ensureDirectories(): Promise<void> {
    const dirs = [
      path.dirname(this.stateFilePath),
      this.lockDirPath,
      this.backupDirPath,
    ];

    for (const dir of dirs) {
      try {
        await fs.mkdir(dir, { mode: 0o700, recursive: true });
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error) {
          const errnoError = error as NodeJS.ErrnoException;
          if (errnoError.code !== 'EEXIST') {
            throw new Error(`Failed to create directory ${dir}: ${errnoError.message}`, { cause: error });
          }
        } else {
          throw new Error(`Failed to create directory ${dir}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
    }
  }

  /**
   * Get the default state object
   */
  private getDefaultState(): SingletonState {
    return {
      version: 1,
      containerId: '',
      containerName: '',
      port: 0,
      sessions: {},
      lastUpdated: Date.now(),
    };
  }

  /**
   * Read the state from the file system with lock protection
   */
  public async readState(): Promise<SingletonState> {
    await this.ensureDirectories();
    const startTime = Date.now();
    try {
      const result = await this.fileLockService.withLock(() => this._readState());
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'read', status: 'success' });
      metrics.increment('state_operations_total', 1, { operation: 'read', status: 'success' });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'read', status: 'error' });
      metrics.increment('state_operations_total', 1, { operation: 'read', status: 'error' });
      throw error;
    }
  }

  /**
   * Internal read without lock acquisition (caller must hold lock)
   */
  public async _readState(): Promise<SingletonState> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content) as unknown;
      this.validator.validateState(state);
      return state as SingletonState;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code === 'ENOENT') {
          return this.getDefaultState();
        }
      }

      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('parse'))) {
        logger.error('[StateManager] State file corrupted, attempting recovery...');
        await this.recoverFromCorruptionDirect();
        try {
          const recovered = await fs.readFile(this.stateFilePath, 'utf-8');
          const recoveredState = JSON.parse(recovered) as unknown;
          this.validator.validateState(recoveredState);
          return recoveredState as SingletonState;
        } catch {
          return this.getDefaultState();
        }
      }

      throw new Error(`Failed to read state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Write the state to the file system atomically with backup creation
   */
  public async writeState(state: SingletonState): Promise<void> {
    await this.ensureDirectories();
    const startTime = Date.now();
    try {
      await this.fileLockService.withLock(() => this._writeState(state));
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'write', status: 'success' });
      metrics.increment('state_operations_total', 1, { operation: 'write', status: 'success' });
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'write', status: 'error' });
      metrics.increment('state_operations_total', 1, { operation: 'write', status: 'error' });
      throw error;
    }
  }

  /**
   * Internal write without lock acquisition (caller must hold lock)
   */
  private async _writeState(state: SingletonState): Promise<void> {
    this.validator.validateState(state);
    state.lastUpdated = Date.now();

    let tempFilePath: string | null = null;
    try {
      await this.backupManager.createBackup();
      const tempFileName = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
      tempFilePath = path.join(path.dirname(this.stateFilePath), tempFileName);
      const content = JSON.stringify(state, null, 2);
      await fs.writeFile(tempFilePath, content, 'utf-8');
      await fs.rename(tempFilePath, this.stateFilePath);
      tempFilePath = null;
      await this.backupManager.cleanupOldBackups();
    } catch (error: unknown) {
      throw new Error(`Failed to write state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch((err) => {
          logger.warn('[StateManager] Failed to clean up temp file:', err);
        });
      }
    }
  }

  /**
   * Update state atomically using an updater function (read-modify-write pattern)
   */
  public async updateState(updater: (state: SingletonState) => SingletonState | Promise<SingletonState>): Promise<void> {
    await this.ensureDirectories();
    const startTime = Date.now();
    try {
      await this.fileLockService.withLock(async () => {
        const currentState = await this._readState();
        const newState = await updater(currentState);
        await this._writeState(newState);
      });
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'update', status: 'success' });
      metrics.increment('state_operations_total', 1, { operation: 'update', status: 'success' });
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.observe('state_operation_duration_ms', duration, { operation: 'update', status: 'error' });
      metrics.increment('state_operations_total', 1, { operation: 'update', status: 'error' });
      throw error;
    }
  }

  // ==================== Session Management ====================

  public async addSession(sessionId: string, param: number | string): Promise<void> {
    await this.sessionApi.addSession(sessionId, param, this.updateState.bind(this), process.pid);
  }

  public async removeSession(sessionId: string): Promise<void> {
    await this.sessionApi.removeSession(sessionId, this.updateState.bind(this));
  }

  public async updateHeartbeat(sessionId: string): Promise<void> {
    await this.sessionApi.updateHeartbeat(sessionId, this.updateState.bind(this));
  }

  public async cleanupStaleSessions(timeoutMs: number): Promise<number> {
    return this.sessionApi.cleanupStaleSessions(timeoutMs, this.readState.bind(this), this.updateState.bind(this));
  }

  public async getSession(sessionId: string): Promise<LegacySessionInfo | null> {
    return this.sessionApi.getSession(sessionId, this.readState.bind(this));
  }

  public async updateActivity(sessionId: string): Promise<void> {
    await this.sessionApi.updateActivity(sessionId, this.updateState.bind(this));
  }

  public async getAllSessions(): Promise<{ [sessionId: string]: LegacySessionInfo }> {
    return this.sessionApi.getAllSessions(this.readState.bind(this));
  }

  // ==================== Browser Management ====================

  public async getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string } | null> {
    return this.browserApi.getBrowserServer(this.readState.bind(this));
  }

  public async setBrowserServer(port: number, pid: number, schedulerId?: string): Promise<void> {
    await this.browserApi.setBrowserServer(port, pid, schedulerId, this.updateState.bind(this));
  }

  public async clearBrowserServer(): Promise<void> {
    await this.browserApi.clearBrowserServer(this.updateState.bind(this));
  }

  public async isPidAlive(pid: number, expectedSchedulerId?: string, skipLock: boolean = false): Promise<boolean> {
    const readFn = skipLock ? this._readState.bind(this) : this.readState.bind(this);
    return this.browserApi.isPidAlive(
      pid,
      expectedSchedulerId,
      readFn,
      this.processLifecycle.isProcessAlive.bind(this.processLifecycle)
    );
  }

  // ==================== GPU Lock Management ====================

  public async acquireGpuLock(sessionId?: string, timeoutMs: number = 30000): Promise<boolean> {
    return this.gpuResourceService.acquireGpuLock(
      (updater) => this.updateState(updater),
      sessionId,
      timeoutMs
    );
  }

  public async releaseGpuLock(pid: number = process.pid): Promise<void> {
    await this.gpuResourceService.releaseGpuLock(
      (updater) => this.updateState(updater),
      pid
    );
  }

  public async getGpuOwner(): Promise<SingletonState['gpuOwner'] | null> {
    return this.gpuResourceService.getGpuOwner(
      () => this.readState()
    );
  }

  // ==================== Metrics ====================

  public async getMetrics(): Promise<StateMetrics> {
    const state = await this.readState();
    return this.metricsCollector.getMetrics(state);
  }

  // ==================== Recovery ====================

  private async recoverFromCorruptionDirect(): Promise<void> {
    try {
      await this.backupManager.recoverFromCorruption();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }

  // ==================== Cleanup ====================

  public async cleanup(): Promise<void> {
    await this.fileLockService.cleanup();
  }

  // ==================== Public Getters ====================

  public getStateFilePath(): string {
    return this.stateFilePath;
  }

  public getLockFilePath(): string {
    return this.lockFilePath;
  }

  public getBackupDirPath(): string {
    return this.backupDirPath;
  }

  getFileLockService(): FileLockService {
    return this.fileLockService;
  }

  getProcessLifecycleService(): ProcessLifecycleService {
    return this.processLifecycle;
  }

  getGpuResourceService(): GPUResourceService {
    return this.gpuResourceService;
  }
}

/**
 * Global singleton StateManager instance
 */
let _sharedStateManager: StateManager | null = null;

export function getSharedStateManager(): StateManager {
  if (!_sharedStateManager) {
    _sharedStateManager = new StateManager();
  }
  return _sharedStateManager;
}