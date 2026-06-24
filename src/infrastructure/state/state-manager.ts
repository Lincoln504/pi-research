/**
 * Shared State Manager
 *
 * Core implementation for cross-process state management.
 * Manages the state file, locking, backups, and provides APIs for
 * session and browser management.
 *
 * This implementation is decomposed into several sub-managers:
 * - FileLockService for file locking
 * - GPUResourceService for GPU lock management
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
import process from 'node:process';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import type { IProcessLifecycle } from '../../core/interfaces/process-interfaces.ts';
import type {
  StateMetrics,
  SingletonState,
} from '../types/state-types.ts';
import { FileLockService } from '../file-lock-service.ts';
import type { GPUResourceService } from '../gpu-resource-service.ts';
import { StateBackupManager } from './state-backup-manager.ts';
import type { StateBrowserManager } from './state-browser-manager.ts';
import type { StateSessionManager } from './state-session-manager.ts';
import type { StateMetricsCollector } from './state-metrics.ts';
import type { StateValidator } from './state-validator.ts';
import { StateSessionApi } from './state-session-api.ts';
import { StateBrowserApi } from './state-browser-api.ts';

// Re-export commonly used types
export type { StateMetrics, SingletonState } from '../types/state-types.ts';

export interface StateManagerOptions {
  stateDir?: string;
  processLifecycle: IProcessLifecycle;
  gpuResourceService: GPUResourceService;
  sessionManager: StateSessionManager;
  browserManager: StateBrowserManager;
  metricsCollector: StateMetricsCollector;
  validator: StateValidator;
  fileLockService: FileLockService;
  backupManager: StateBackupManager;
}

/**
 * Shared State Manager Implementation
 */
export class StateManager {
  private stateFilePath: string;
  private lockDirPath: string;
  private backupDirPath: string;
  private lockFilePath: string;

  // Sub-services (injected via constructor)
  private readonly fileLockService: FileLockService;
  private readonly processLifecycle: IProcessLifecycle;
  private readonly gpuResourceService: GPUResourceService;
  private readonly sessionApi: StateSessionApi;
  private readonly browserApi: StateBrowserApi;
  private readonly backupManager: StateBackupManager;
  private readonly metricsCollector: StateMetricsCollector;
  private readonly validator: StateValidator;

  constructor(options: StateManagerOptions) {
    const {
      stateDir: providedStateDir,
      processLifecycle,
      fileLockService,
      gpuResourceService,
      sessionManager,
      browserManager,
      backupManager,
      metricsCollector,
      validator,
    } = options;
    
    let stateDir = providedStateDir;
    
    if (!stateDir) {
      const homeDir = os.homedir();
      stateDir = path.join(homeDir, CONFIG_DIR_NAME, 'state');
    }

    this.stateFilePath = path.join(stateDir, 'research-state.json');
    this.lockDirPath = path.join(stateDir, '.locks');
    this.backupDirPath = path.join(stateDir, 'backups');
    this.lockFilePath = path.join(this.lockDirPath, 'research-state.lock');

    // Use injected services
    this.fileLockService = fileLockService;
    this.processLifecycle = processLifecycle;
    this.gpuResourceService = gpuResourceService;
    this.sessionApi = new StateSessionApi(sessionManager);
    this.browserApi = new StateBrowserApi(browserManager);
    this.backupManager = backupManager;
    this.metricsCollector = metricsCollector;
    this.validator = validator;
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
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        logger.error(`[StateManager] Failed to create directory ${dir}:`, err);
        throw err;
      }
    }
  }

  /**
   * Get the default state
   */
  private getDefaultState(): SingletonState {
    return {
      version: 1,
      containerId: crypto.randomBytes(16).toString('hex'),
      containerName: 'pi-research-shared-state',
      port: 0,
      sessions: {},
      lastUpdated: Date.now(),
    };
  }

  // ==================== Core State Operations ====================

  /**
   * Internal read without lock acquisition (caller must hold lock)
   */
  private async _readState(): Promise<SingletonState> {
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content) as unknown;
      return this.validator.validateState(state);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
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
          return this.validator.validateState(recoveredState);
        } catch {
          return this.getDefaultState();
        }
      }

      throw new Error(`Failed to read state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Read the state from the file system
   * @param skipLock If true, skip acquiring the file lock (caller must hold it)
   */
  public async readState(skipLock?: boolean): Promise<SingletonState> {
    await this.ensureDirectories();
    if (skipLock) {
      return await this._readState();
    }
    return await this.fileLockService.withLock(async () => {
      return await this._readState();
    });
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
      // Open, write, fsync, close — ensures data is on disk before rename is visible.
      const fh = await fs.open(tempFilePath, 'w', 0o600);
      try {
        await fh.writeFile(content, { encoding: 'utf-8' });
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fs.rename(tempFilePath, this.stateFilePath);
      } catch (renameErr) {
        // fs.rename fails on Windows if target exists (NTFS). Fall back to copy+delete.
        if (process.platform === 'win32') {
          await fs.copyFile(tempFilePath, this.stateFilePath);
          await fs.unlink(tempFilePath);
        } else {
          throw renameErr;
        }
      }
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
   * Update state atomically using an updater function
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

  // ==================== Session API ====================

  public async addSession(sessionId: string, param: number | string): Promise<void> {
    await this.sessionApi.addSession(
      sessionId,
      param,
      this.updateState.bind(this),
      process.pid,
      this.processLifecycle.getProcessStartTime.bind(this.processLifecycle)
    );
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

  // ==================== Browser API ====================

  public async getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string; startTime?: number | null; authSecret?: string } | null> {
    return this.browserApi.getBrowserServer(this.readState.bind(this));
  }

  public async setBrowserServer(port: number, pid: number, schedulerId?: string, authSecret?: string): Promise<void> {
    await this.browserApi.setBrowserServer(
      port,
      pid,
      schedulerId,
      this.updateState.bind(this),
      this.processLifecycle.getProcessStartTime.bind(this.processLifecycle),
      authSecret
    );
  }

  public async clearBrowserServer(): Promise<void> {
    await this.browserApi.clearBrowserServer(this.updateState.bind(this));
  }

  // ==================== Embedding Server API ====================

  public async getEmbeddingServer(): Promise<{ port: number; pid: number; serverId: string } | null> {
    const state = await this.readState();
    return state.embeddingServer ?? null;
  }

  public async clearEmbeddingServer(): Promise<void> {
    await this.updateState((state) => {
      delete state.embeddingServer;
      return state;
    });
  }

  // ==================== Process API ====================

  public async isPidAlive(pid: number, expectedSchedulerId?: string, skipLock?: boolean): Promise<boolean> {
    const state = await this.readState(skipLock);
    const expectedStartTime = state.browserServer?.pid === pid ? state.browserServer.startTime : undefined;

    return this.processLifecycle.isPidAlive(pid, expectedSchedulerId, {
      getState: (s?: boolean) => this.readState(s ?? skipLock),
      skipLock,
      getSchedulerIdFromState: (state: SingletonState) => state.browserServer?.schedulerId,
      expectedStartTime,
    });
  }

  // ==================== GPU Lock API ====================

  public async acquireGpuLock(sessionId?: string, timeoutMs?: number): Promise<boolean> {
    return this.gpuResourceService.acquireGpuLock(this.updateState.bind(this) as any, sessionId, timeoutMs);
  }

  public async releaseGpuLock(pid?: number): Promise<void> {
    await this.gpuResourceService.releaseGpuLock(this.updateState.bind(this) as any, pid);
  }

  public async getGpuOwner(): Promise<SingletonState['gpuOwner'] | null> {
    const state = await this.readState();
    return state.gpuOwner || null;
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

  getProcessLifecycleService(): IProcessLifecycle {
    return this.processLifecycle;
  }

  getGpuResourceService(): GPUResourceService {
    return this.gpuResourceService;
  }
}
