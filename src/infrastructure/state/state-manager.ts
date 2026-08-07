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
import process from 'node:process';
import { getGlobalConfigDir } from '../../config.ts';
import { logger } from '../../logger.ts';
import { replaceFile } from '../../utils/atomic-replace.ts';
import { metrics } from '../../utils/metrics.ts';
import type { IProcessLifecycle } from '../../core/interfaces/process-interfaces.ts';
import type {
  StateMetrics,
  SingletonState,
} from '../types/state-types.ts';
import { CURRENT_STATE_VERSION } from '../types/state-types.ts';
import { FileLockService } from '../file-lock-service.ts';
import type { GPUResourceService } from '../gpu-resource-service.ts';
import { StateBackupManager } from './state-backup-manager.ts';
import { StateVersionTooNewError } from './state-migration.ts';
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

  // Set when a read finds the state file was written by a newer build than this
  // process supports. While set, writes are suppressed so we never overwrite the
  // newer file (which holds that build's sessions, browser lease, authSecret).
  private stateTooNew = false;

  // One-time guard for the orphaned-temp sweep below.
  private orphanTmpSwept = false;

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
      // pi-research's own namespace (~/.pi/research/state), not the host pi root.
      stateDir = path.join(getGlobalConfigDir(), 'state');
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

    await this.sweepOrphanedTempFiles();
  }

  /**
   * Reclaim orphaned `research-state-*.tmp` files left in the state dir.
   *
   * Both the primary writer (_writeState) and the recovery writer
   * (StateBackupManager.atomicWriteStateFile) write via temp+fsync+rename. The
   * in-process `finally` cleans the temp on a failed write, but a process killed
   * mid-write (SIGKILL, crash, OOM) between open and rename leaks the temp, and
   * nothing else ever removes it — only backups/ is pruned. Sweep them here, once,
   * on the first directory ensure.
   *
   * Only temps older than a safety window are removed: a live write holds the
   * state lock and a temp exists for milliseconds, so anything older than the
   * window cannot belong to a concurrent in-flight write (in this or another
   * process). This makes the sweep safe without taking the state lock.
   */
  private async sweepOrphanedTempFiles(): Promise<void> {
    if (this.orphanTmpSwept) return;
    this.orphanTmpSwept = true;

    const STALE_TMP_MS = 5 * 60 * 1000; // 5 minutes — far longer than any real write
    const stateDir = path.dirname(this.stateFilePath);
    const cutoff = Date.now() - STALE_TMP_MS;
    try {
      const entries = await fs.readdir(stateDir);
      for (const entry of entries) {
        if (!entry.startsWith('research-state-') || !entry.endsWith('.tmp')) continue;
        const filePath = path.join(stateDir, entry);
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile() || stats.mtimeMs >= cutoff) continue;
          await fs.unlink(filePath);
          logger.debug(`[StateManager] Removed orphaned state temp file: ${entry}`);
        } catch {
          // Raced with another sweeper or the file vanished — ignore.
        }
      }
    } catch (err) {
      // Never let cleanup hygiene fail directory setup.
      logger.debug('[StateManager] Orphaned temp sweep failed (non-fatal):', err);
    }
  }

  /**
   * Get the default state
   */
  private getDefaultState(): SingletonState {
    return {
      version: CURRENT_STATE_VERSION,
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
    // Once this process has seen a newer-build state file, it runs read-only on an in-memory
    // default for the rest of its life (writes are suppressed in _writeState). Short-circuit
    // here so every subsequent read does NOT re-open the file, re-throw StateVersionTooNewError,
    // and re-quarantine a fresh copy on each call — which, on a hot path (heartbeats, GPU lock,
    // metrics), produced an unbounded storm of `*.quarantine` copies under the state lock.
    if (this.stateTooNew) {
      return this.getDefaultState();
    }
    try {
      const content = await fs.readFile(this.stateFilePath, 'utf-8');
      const state = JSON.parse(content) as unknown;
      return this.validator.migrateAndValidate(state);
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code === 'ENOENT') {
          return this.getDefaultState();
        }
      }

      // A file written by a NEWER build is not corruption. Recovering/overwriting
      // it would destroy that build's live sessions, browser lease, and
      // authSecret. Instead: quarantine a copy for forensics, mark this process
      // read-only so no write clobbers the newer file, and run on an in-memory
      // default. Normal service resumes once this build is upgraded.
      if (error instanceof StateVersionTooNewError) {
        logger.error(
          `[StateManager] ${error.message} Running in read-only mode on an in-memory default; writes are suppressed to protect the newer file.`,
        );
        this.stateTooNew = true;
        await this.backupManager
          .quarantineFutureState(error.fileVersion)
          .catch((qErr: unknown) =>
            logger.warn(
              `[StateManager] Failed to quarantine newer state file: ${qErr instanceof Error ? qErr.message : String(qErr)}`,
            ),
          );
        return this.getDefaultState();
      }

      // Corruption is not only truncated/garbage JSON — a well-formed file can
      // still fail schema validation (missing field, out-of-range port). These
      // throw from JSON.parse (SyntaxError) or validateState ("Invalid state:
      // ..."). Treat every such case as recoverable so a single bad file can
      // never brick every reader; genuine I/O errors (EACCES/EPERM/EISDIR) are
      // NOT corruption and still surface via the throw below. A future `version`
      // is handled separately above (quarantine, not overwrite).
      // A missing migration step ("No migration registered from state version
      // N…") means an old, un-upgradeable file — recover to a fresh default like
      // any other corruption. A buggy migration ("Migration … produced version
      // …") is a programming error and is intentionally left to surface.
      const isCorruption =
        error instanceof SyntaxError ||
        (error instanceof Error &&
          (error.message.includes('parse') ||
            error.message.startsWith('Invalid state') ||
            error.message.startsWith('No migration registered')));
      if (isCorruption) {
        logger.error(
          `[StateManager] State file corrupt/invalid (${error instanceof Error ? error.message : String(error)}); attempting recovery...`,
        );
        try {
          await this.recoverFromCorruptionDirect();
          const recovered = await fs.readFile(this.stateFilePath, 'utf-8');
          return this.validator.migrateAndValidate(JSON.parse(recovered) as unknown);
        } catch (recoveryError) {
          logger.error(
            `[StateManager] Recovery failed (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}); using in-memory default state.`,
          );
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
    // A prior read found a newer-build state file on disk. Suppress the write so
    // we do not clobber that build's live state with our older-schema view. The
    // in-memory updates are lost, which is the intended degradation: data loss
    // of the newer file is the far worse outcome. (All mutations flow through
    // updateState, which reads — and so sets this flag — before writing.)
    if (this.stateTooNew) {
      logger.warn('[StateManager] Skipping state write: on-disk state was written by a newer build (read-only mode).');
      return;
    }
    this.validator.validateState(state);
    state.lastUpdated = Date.now();

    let tempFilePath: string | null = null;
    try {
      // Backups are a safety net, not a prerequisite for writing. The atomic
      // temp+fsync+rename below already protects the primary file, so a failed
      // backup (e.g. unwritable backups/ dir) must NOT fail-close every state
      // write — log and continue. This also keeps backup I/O from extending the
      // time the state lock is held on a degraded disk.
      await this.backupManager.createBackup().catch((err: unknown) => {
        logger.warn(`[StateManager] Backup before write failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
      });
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
      // Atomic where the platform allows; on Windows a third-party lock on the target
      // is retried before conceding to a non-atomic copy (see replaceFile).
      const outcome = await replaceFile(tempFilePath, this.stateFilePath);
      if (outcome === 'copied') {
        logger.warn(
          '[StateManager] State written via non-atomic copy: the rename was blocked by another ' +
          'process holding the state file. A concurrent reader may observe a partial file.',
        );
        metrics.increment('state_write_non_atomic_total', 1);
        // The state IS persisted, so removing the temp is best-effort: a transient AV lock
        // on the temp would otherwise throw and report "Failed to write state" for a write
        // that actually succeeded — a caller retrying or aborting on that would act wrongly.
        const tmp = tempFilePath;
        tempFilePath = null;
        await fs.unlink(tmp).catch((err) => {
          logger.warn('[StateManager] Failed to remove temp file after copy fallback (write succeeded):', err);
        });
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

  public async clearBrowserServer(expected?: { pid?: number; schedulerId?: string }): Promise<void> {
    await this.browserApi.clearBrowserServer(this.updateState.bind(this), expected);
  }

  // ==================== Embedding Server API ====================

  public async getEmbeddingServer(): Promise<{ port: number; pid: number; startTime?: number; serverId: string; model?: string; authSecret?: string } | null> {
    const state = await this.readState();
    return state.embeddingServer ?? null;
  }

  public async clearEmbeddingServer(expected?: { pid?: number; serverId?: string }): Promise<void> {
    await this.updateState((state) => {
      // Compare-and-delete: the registration is shared cross-process state, and an
      // unconditional delete lets a follower's shutdown (or a waiter acting on a
      // stale snapshot) deregister a DIFFERENT process's live leader — which then
      // never re-registers (its leadership check treats an absent entry as benign),
      // so a fresh caller elects a second GPU model instance alongside the invisible
      // one. Callers pass the identity they believe they are clearing; a mismatch
      // means someone else already claimed the slot, and the clear must no-op.
      const entry = state.embeddingServer;
      if (entry && expected !== undefined) {
        if (expected.serverId !== undefined && entry.serverId !== expected.serverId) return state;
        if (expected.pid !== undefined && entry.pid !== expected.pid) return state;
      }
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
