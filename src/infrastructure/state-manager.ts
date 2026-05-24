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
 * Type guard to check if a value is a SingletonState
 */
function isSingletonState(value: unknown): value is SingletonState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const state = value as Partial<SingletonState>;

  return (
    state.version === 1 &&
    typeof state.containerId === 'string' &&
    typeof state.containerName === 'string' &&
    typeof state.port === 'number' &&
    typeof state.sessions === 'object' &&
    typeof state.lastUpdated === 'number'
  );
}

/**
 * Type guard to check if a value is a SessionInfo
 */
function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const session = value as Partial<SessionInfo>;

  return (
    typeof session.pid === 'number' &&
    typeof session.lastSeen === 'number' &&
    typeof session.connectedAt === 'number'
  );
}

/**
 * StateManager class for managing singleton state with file-based storage,
 * file locking, backup system, and corruption recovery.
 *
 * Refactored to delegate to specialized services:
 * - FileLockService for cross-process locking
 * - ProcessLifecycleService for PID checks
 * - GPUResourceService for GPU locking
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
   * @returns The current state object
   * @throws Error if unable to read, parse, or acquire lock
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

      // Validate state structure and version
      this.validateState(state);

      return state as SingletonState;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code === 'ENOENT') {
          // File doesn't exist, return default state
          return this.getDefaultState();
        }
      }

      // Check for corruption
      if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('parse'))) {
        logger.error('[StateManager] State file corrupted, attempting recovery...');
        // Recover directly — we already hold the lock
        await this.recoverFromCorruptionDirect();
        // Re-read directly
        try {
          const recovered = await fs.readFile(this.stateFilePath, 'utf-8');
          const recoveredState = JSON.parse(recovered) as unknown;
          this.validateState(recoveredState);
          return recoveredState as SingletonState;
        } catch {
          // Recovery produced an unreadable file — return safe default.
          return this.getDefaultState();
        }
      }

      throw new Error(`Failed to read state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Write the state to the file system atomically with backup creation
   * @param state The state object to write
   * @throws Error if unable to write or backup
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
    this.validateState(state);

    // Update lastUpdated timestamp
    state.lastUpdated = Date.now();

    let tempFilePath: string | null = null;
    try {
      // Create backup before writing
      await this.createBackup();

      // Create temporary file with UUID for atomic write
      const tempFileName = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
      tempFilePath = path.join(path.dirname(this.stateFilePath), tempFileName);

      // Write to temporary file
      const content = JSON.stringify(state, null, 2);
      await fs.writeFile(tempFilePath, content, 'utf-8');

      // Atomic rename to target file
      await fs.rename(tempFilePath, this.stateFilePath);
      tempFilePath = null;

      // Cleanup old backups
      await this.cleanupOldBackups();
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
   * @param updater Function that receives current state and returns updated state
   * @throws Error if unable to read, update, or write state
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

  /**
   * Add a new session to the state
   * @param sessionId The session ID to add
   * @param param PID (number) or container name (string)
   * @throws Error if unable to update state
   */
  public async addSession(sessionId: string, param: number | string): Promise<void> {
    let pid: number;
    if (typeof param === 'number') {
      pid = param;
    } else {
      // param is containerName string, use current process pid
      pid = process.pid;
    }

    await this.updateState(async (state): Promise<SingletonState> => {
      state.sessions[sessionId] = {
        pid,
        lastSeen: Date.now(),
        connectedAt: Date.now(),
      };

      return state;
    });
  }

  /**
   * Remove a session from the state
   * @param sessionId The session ID to remove
   */
  public async removeSession(sessionId: string): Promise<void> {
    await this.updateState((state): SingletonState => {
      if (state.sessions[sessionId] !== undefined) {
        delete state.sessions[sessionId];
      }
      return state;
    });
  }

  /**
   * Update the heartbeat timestamp for a session
   * @param sessionId The session ID to update
   */
  public async updateHeartbeat(sessionId: string): Promise<void> {
    await this.updateState((state): SingletonState => {
      const session = state.sessions[sessionId];
      if (session !== undefined) {
        session.lastSeen = Date.now();
      }
      return state;
    });
  }

  /**
   * Clean up stale sessions based on timeout and process liveness
   * @param timeoutMs Timeout in milliseconds for session staleness
   * @returns Number of sessions removed
   */
  public async cleanupStaleSessions(timeoutMs: number): Promise<number> {
    const now = Date.now();
    // Map sessionId -> lastSeen snapshot at classify time, used to detect
    // concurrent updates between the read-lock and the write-lock.
    const sessionsToRemove = new Map<string, number>();

    const state = await this.readState();

    for (const [sessionId, sessionInfo] of Object.entries(state.sessions)) {
      // Primary check: lastSeen timeout
      const lastSeenAge = now - sessionInfo.lastSeen;

      if (lastSeenAge > timeoutMs) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
        continue;
      }

      // Secondary check: is process still alive?
      const isAlive = this.processLifecycle.isProcessAlive(sessionInfo.pid);

      if (!isAlive) {
        sessionsToRemove.set(sessionId, sessionInfo.lastSeen);
      }
    }

    // Remove stale sessions under a fresh lock. Re-validate lastSeen so a
    // session that received a heartbeat between the two lock acquisitions is
    // not accidentally deleted (TOCTOU guard).
    if (sessionsToRemove.size > 0) {
      await this.updateState((state): SingletonState => {
        for (const [sessionId, lastSeenAtClassify] of sessionsToRemove) {
          const current = state.sessions[sessionId];
          if (current && current.lastSeen === lastSeenAtClassify) {
            delete state.sessions[sessionId];
          }
        }
        return state;
      });
    }

    return sessionsToRemove.size;
  }

  /**
   * Get metrics about the current state
   * @returns StateMetrics object with various statistics
   */
  public async getMetrics(): Promise<StateMetrics> {
    const state = await this.readState();
    const now = Date.now();

    const sessionEntries = Object.entries(state.sessions);
    const totalSessions = sessionEntries.length;

    let activeSessions = 0;
    let oldestSession: number | null = null;
    let newestSession: number | null = null;
    let lastHeartbeatAge: number | null = null;

    for (const [, sessionInfo] of sessionEntries) {
      // Check if session is active (lastSeen within last 5 minutes)
      if (now - sessionInfo.lastSeen < 300000) {
        activeSessions++;
      }

      // Track oldest and newest connection times
      if (oldestSession === null || sessionInfo.connectedAt < oldestSession) {
        oldestSession = sessionInfo.connectedAt;
      }

      if (newestSession === null || sessionInfo.connectedAt > newestSession) {
        newestSession = sessionInfo.connectedAt;
      }

      // Track last heartbeat age
      const heartbeatAge = now - sessionInfo.lastSeen;
      if (lastHeartbeatAge === null || heartbeatAge > lastHeartbeatAge) {
        lastHeartbeatAge = heartbeatAge;
      }
    }

    // Calculate container uptime if container exists
    let containerUptime: number | null = null;
    if (state.containerId !== '') {
      // Use lastUpdated as approximation for container uptime
      containerUptime = now - state.lastUpdated;
    }

    // Export to metrics system
    metrics.setGauge('state_sessions_total', totalSessions);
    metrics.setGauge('state_sessions_active', activeSessions);
    metrics.setGauge('state_browser_server_exists', state.browserServer ? 1 : 0);
    metrics.setGauge('state_gpu_lock_owner_exists', state.gpuOwner ? 1 : 0);

    return {
      totalSessions,
      activeSessions,
      oldestSession,
      newestSession,
      containerUptime,
      lastHeartbeatAge,
    };
  }

  /**
   * Get the current browser server information
   */
  public async getBrowserServer(): Promise<{ port: number; pid: number; schedulerId?: string } | null> {
    const state = await this.readState();
    return state.browserServer ?? null;
  }

  /**
   * Set the current browser server information (atomic: only overwrites if no live server exists)
   */
  public async setBrowserServer(port: number, pid: number, schedulerId?: string): Promise<void> {
    await this.updateState((state) => {
      state.browserServer = { port, pid, schedulerId };
      return state;
    });
  }

  /**
   * Clear the browser server information
   */
  public async clearBrowserServer(): Promise<void> {
    await this.updateState((state) => {
      delete state.browserServer;
      return state;
    });
  }

  /**
   * Check if a process is alive with optional scheduler ID verification
   */
  public async isPidAlive(pid: number, expectedSchedulerId?: string, skipLock: boolean = false): Promise<boolean> {
    const alive = this.processLifecycle.isProcessAlive(pid);
    if (!alive) return false;

    if (expectedSchedulerId) {
      // Use _readState() if skipLock is true to prevent deadlocks when called inside updateState.
      const state = skipLock ? await this._readState() : await this.readState();
      return state.browserServer?.schedulerId === expectedSchedulerId;
    }

    return true;
  }

  /**
   * Acquire the global GPU resource lock.
   * Only one process can hold the GPU lock at a time.
   * @param sessionId Optional session ID for tracking
   * @param timeoutMs Maximum time to wait for the lock
   * @returns true if lock was acquired, false if timed out
   */
  public async acquireGpuLock(sessionId?: string, timeoutMs: number = 30000): Promise<boolean> {
    return this.gpuResourceService.acquireGpuLock(
      (updater) => this.updateState(updater),
      sessionId,
      timeoutMs
    );
  }

  /**
   * Release the global GPU resource lock if held by this process.
   * @param pid Optional PID to release for (defaults to current process)
   */
  public async releaseGpuLock(pid: number = process.pid): Promise<void> {
    await this.gpuResourceService.releaseGpuLock(
      (updater) => this.updateState(updater),
      pid
    );
  }

  /**
   * Get information about the current GPU owner
   */
  public async getGpuOwner(): Promise<SingletonState['gpuOwner'] | null> {
    return this.gpuResourceService.getGpuOwner(
      () => this.readState()
    );
  }

  /**
   * Create a backup of the current state file
   * @throws Error if unable to create backup
   */
  private async createBackup(): Promise<void> {
    try {
      // Check if state file exists
      try {
        await fs.access(this.stateFilePath);
      } catch {
        // No state file to backup
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `research-state-${timestamp}.json`;
      const backupFilePath = path.join(this.backupDirPath, backupFileName);

      await fs.copyFile(this.stateFilePath, backupFilePath);
    } catch (error: unknown) {
      throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Clean up old backups, keeping only the most recent maxBackups
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const entries = await fs.readdir(this.backupDirPath);

      if (entries.length <= this.maxBackups) {
        return;
      }

      // Get file stats and sort by modification time (newest first)
      const backupFiles: Array<{ name: string; mtime: Date }> = [];

      for (const entry of entries) {
        const filePath = path.join(this.backupDirPath, entry);
        const stats = await fs.stat(filePath);

        if (stats.isFile() && entry.startsWith('research-state-') && entry.endsWith('.json')) {
          backupFiles.push({ name: entry, mtime: stats.mtime });
        }
      }

      // Sort by mtime, newest first
      backupFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // Remove backups beyond the max count
      const backupsToRemove = backupFiles.slice(this.maxBackups);
      for (const backupFile of backupsToRemove) {
        const filePath = path.join(this.backupDirPath, backupFile.name);
        await fs.unlink(filePath);
      }
    } catch (error: unknown) {
      logger.error(`Failed to cleanup old backups: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Recover from corruption by restoring a backup or writing a default state.
   * Does NOT call withLock — safe to call when the caller already holds the lock.
   */
  private async recoverFromCorruptionDirect(): Promise<void> {
    try {
      // Find the newest valid backup
      let newestBackup: { name: string; mtime: Date } | null = null;
      try {
        const entries = await fs.readdir(this.backupDirPath);
        for (const entry of entries) {
          const filePath = path.join(this.backupDirPath, entry);
          const stats = await fs.stat(filePath);
          if (stats.isFile() && entry.startsWith('research-state-') && entry.endsWith('.json')) {
            if (newestBackup === null || stats.mtime > newestBackup.mtime) {
              newestBackup = { name: entry, mtime: stats.mtime };
            }
          }
        }
      } catch {
        // Backup directory unreadable — fall through to default state
      }

      if (newestBackup !== null) {
        const backupPath = path.join(this.backupDirPath, newestBackup.name);
        await fs.copyFile(backupPath, this.stateFilePath);
        logger.log(`[StateManager] Recovered state from backup: ${newestBackup.name}`);
      } else {
        // No backups — write default state directly (atomic rename, no lock needed)
        const defaultState = this.getDefaultState();
        defaultState.lastUpdated = Date.now();
        const tempFile = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
        const tempPath = path.join(path.dirname(this.stateFilePath), tempFile);
        await fs.writeFile(tempPath, JSON.stringify(defaultState, null, 2), 'utf-8');
        await fs.rename(tempPath, this.stateFilePath);
        logger.log('[StateManager] Recovered with default state (no backups available)');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StateManager] Failed to recover from corruption: ${message}`);
      throw error;
    }
  }

  /**
   * Validate the structure and version of a state object
   * @param state The state object to validate
   * @throws Error if state structure or version is invalid
   */
  private validateState(state: unknown): void {
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid state: not an object');
    }

    if (!isSingletonState(state)) {
      throw new Error('Invalid state: structure or version mismatch');
    }

    // Type guard already validated the structure, now validate values
    if (state.port < 0 || state.port > 65535) {
      throw new Error(`Invalid state: port must be a number between 0 and 65535, got ${state.port}`);
    }

    if (state.lastUpdated < 0) {
      throw new Error(`Invalid state: lastUpdated must be a non-negative number, got ${state.lastUpdated}`);
    }

    if (state.browserServer !== undefined) {
      const bs = state.browserServer;
      if (typeof bs.port !== 'number' || typeof bs.pid !== 'number') {
        throw new Error('Invalid state: browserServer must have numeric port and pid fields');
      }
      if (bs.port < 0 || bs.port > 65535) {
        throw new Error(`Invalid state: browserServer.port must be 0-65535, got ${bs.port}`);
      }
    }

    if (state.schedulerVersion !== undefined && typeof state.schedulerVersion !== 'string') {
      throw new Error('Invalid state: schedulerVersion must be a string');
    }

    if (state.gpuOwner !== undefined) {
      const go = state.gpuOwner;
      if (typeof go.pid !== 'number' || typeof go.startedAt !== 'number') {
        throw new Error('Invalid state: gpuOwner must have numeric pid and startedAt fields');
      }
    }

    for (const [sessionId, sessionData] of Object.entries(state.sessions)) {
      if (typeof sessionId !== 'string') {
        throw new Error('Invalid state: session IDs must be strings');
      }

      if (!isSessionInfo(sessionData)) {
        throw new Error(`Invalid state: session data for ${sessionId} has invalid structure`);
      }

      if (sessionData.pid < 0) {
        throw new Error(`Invalid state: pid for ${sessionId} must be a non-negative number, got ${sessionData.pid}`);
      }

      if (sessionData.lastSeen < 0) {
        throw new Error(`Invalid state: lastSeen for ${sessionId} must be a non-negative number, got ${sessionData.lastSeen}`);
      }

      if (sessionData.connectedAt < 0) {
        throw new Error(`Invalid state: connectedAt for ${sessionId} must be a non-negative number, got ${sessionData.connectedAt}`);
      }
    }
  }

  // ==================== Backward compatibility methods ====================

  /**
   * Get a session by ID (backward compatible)
   * @param sessionId The session ID to retrieve
   * @returns The session data or null if not found
   */
  public async getSession(sessionId: string): Promise<LegacySessionInfo | null> {
    const state = await this.readState();
    const session = state.sessions[sessionId];

    if (session === undefined) {
      return null;
    }

    // Return only lastSeen for backward compatibility
    return {
      lastSeen: session.lastSeen,
    };
  }

  /**
   * Update the activity timestamp for a session (backward compatible)
   * @param sessionId The session ID to update
   */
  public async updateActivity(sessionId: string): Promise<void> {
    await this.updateHeartbeat(sessionId);
  }

  /**
   * Get all sessions (backward compatible)
   * @returns A copy of all sessions with legacy structure
   */
  public async getAllSessions(): Promise<{ [sessionId: string]: LegacySessionInfo }> {
    const state = await this.readState();
    const legacySessions: { [sessionId: string]: LegacySessionInfo } = {};

    for (const [sessionId, sessionInfo] of Object.entries(state.sessions)) {
      legacySessions[sessionId] = {
        lastSeen: sessionInfo.lastSeen,
      };
    }

    return legacySessions;
  }

  /**
   * Clean up resources (release lock if held)
   * Should be called when shutting down
   */
  public async cleanup(): Promise<void> {
    await this.fileLockService.cleanup();
  }

  // ==================== Public getter methods ====================

  /**
   * Get the state file path
   * @returns The path to the state file
   */
  public getStateFilePath(): string {
    return this.stateFilePath;
  }

  /**
   * Get the lock file path
   * @returns The path to the lock file
   */
  public getLockFilePath(): string {
    return this.lockFilePath;
  }

  /**
   * Get the backup directory path
   * @returns The path to the backup directory
   */
  public getBackupDirPath(): string {
    return this.backupDirPath;
  }

  /**
   * Get the file lock service (for testing purposes)
   */
  getFileLockService(): FileLockService {
    return this.fileLockService;
  }

  /**
   * Get the process lifecycle service (for testing purposes)
   */
  getProcessLifecycleService(): ProcessLifecycleService {
    return this.processLifecycle;
  }

  /**
   * Get the GPU resource service (for testing purposes)
   */
  getGpuResourceService(): GPUResourceService {
    return this.gpuResourceService;
  }
}

/**
 * Global singleton StateManager instance
 */
let _sharedStateManager: StateManager | null = null;

/**
 * Get the shared StateManager instance for this process.
 * Module-level singleton so cleanupStaleLocksOnStartup() fires exactly once.
 */
export function getSharedStateManager(): StateManager {
  if (!_sharedStateManager) {
    _sharedStateManager = new StateManager();
  }
  return _sharedStateManager;
}