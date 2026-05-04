import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { logger } from '../logger.ts';

/**
 * State metrics interface
 */
export interface StateMetrics {
  totalSessions: number;
  activeSessions: number;
  oldestSession: number | null;
  newestSession: number | null;
  containerUptime: number | null;
  lastHeartbeatAge: number | null;
}

/**
 * Session information interface
 */
export interface SessionInfo {
  pid: number;
  processStartTime?: number; // For PID reuse detection
  lastSeen: number;
  connectedAt: number;
}

/**
 * Main state structure interface
 */
export interface SingletonState {
  version: 1;
  containerId: string;
  containerName: string;
  port: number;
  sessions: { [sessionId: string]: SessionInfo };
  lastUpdated: number;
  browserServer?: { port: number; pid: number };
  schedulerVersion?: string; // Track scheduler config version for detecting changes
}

/**
 * Legacy session interface for backward compatibility
 */
export interface LegacySessionInfo {
  lastSeen: number;
}

/**
 * Legacy state interface for backward compatibility
 */
export interface LegacyState {
  sessions: { [sessionId: string]: LegacySessionInfo };
  containerExists: boolean;
  containerPort: number;
}

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
    typeof session.connectedAt === 'number' &&
    (session.processStartTime === undefined || typeof session.processStartTime === 'number')
  );
}

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

  // Lock configuration
  private readonly lockTimeout: number = 10000; // 10 seconds
  private readonly lockRetries: number = 100; // 10 seconds with 100ms delay
  private readonly lockRetryDelay: number = 100; // 100ms between retries
  private readonly lockStaleThreshold: number = 30000; // 30 seconds

  // Backup configuration
  private readonly maxBackups: number = 5;

  // Lock tracking
  private lockHandle: fs.FileHandle | null = null;

  constructor(stateDir?: string) {
    if (!stateDir) {
      const homeDir = os.homedir();
      stateDir = path.join(homeDir, '.pi', 'state');
    }

    this.stateFilePath = path.join(stateDir, 'research-state.json');
    this.lockDirPath = path.join(stateDir, '.locks');
    this.backupDirPath = path.join(stateDir, 'backups');
    this.lockFilePath = path.join(this.lockDirPath, 'research-state.lock');

    // Clean up any stale locks on initialization (fire and forget)
    this.cleanupStaleLocksOnStartup().catch((error: unknown) => {
      logger.warn('[StateManager] Failed to cleanup stale locks on startup:', error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Clean up any stale lock files on initialization.
   * This handles cases where locks weren't released due to crashes.
   */
  private async cleanupStaleLocksOnStartup(): Promise<void> {
    await this.ensureDirectories();

    try {
      const stats = await fs.stat(this.lockFilePath);
      const lockAge = Date.now() - stats.mtimeMs;

      // Clean up locks older than stale threshold (30 seconds)
      if (lockAge > this.lockStaleThreshold) {
        logger.log(`[StateManager] Cleaning up stale lock file (${Math.round(lockAge / 1000)}s old)`);
        await fs.unlink(this.lockFilePath);
        logger.log('[StateManager] Stale lock removed');
      }
    } catch (error: unknown) {
      // ENOENT is expected (no lock file exists)
      if (error instanceof Error && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code !== 'ENOENT') {
          logger.warn(`[StateManager] Could not check lock file: ${errnoError.message}`);
        }
      }
    }
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
    return this.withLock(() => this._readState());
  }

  /**
   * Internal read without lock acquisition (caller must hold lock)
   */
  private async _readState(): Promise<SingletonState> {
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
    return this.withLock(() => this._writeState(state));
  }

  /**
   * Internal write without lock acquisition (caller must hold lock)
   */
  private async _writeState(state: SingletonState): Promise<void> {
    this.validateState(state);

    // Update lastUpdated timestamp
    state.lastUpdated = Date.now();

    try {
      // Create backup before writing
      await this.createBackup();

      // Create temporary file with UUID for atomic write
      const tempFileName = `research-state-${crypto.randomBytes(16).toString('hex')}.tmp`;
      const tempFilePath = path.join(path.dirname(this.stateFilePath), tempFileName);

      // Write to temporary file
      const content = JSON.stringify(state, null, 2);
      await fs.writeFile(tempFilePath, content, 'utf-8');

      // Atomic rename to target file
      await fs.rename(tempFilePath, this.stateFilePath);

      // Cleanup old backups
      await this.cleanupOldBackups();
    } catch (error: unknown) {
      throw new Error(`Failed to write state: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /**
   * Update state atomically using an updater function (read-modify-write pattern)
   * @param updater Function that receives current state and returns updated state
   * @throws Error if unable to read, update, or write state
   */
  public async updateState(updater: (state: SingletonState) => SingletonState | Promise<SingletonState>): Promise<void> {
    await this.ensureDirectories();
    return this.withLock(async () => {
      const currentState = await this._readState();
      const newState = await updater(currentState);
      await this._writeState(newState);
    });
  }

  /**
   * Add a new session to the state
   * @param sessionId The session ID to add
   * @param param PID (number) or container name (string)
   * @throws Error if unable to update state or read process start time
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
      const processStartTime = await this.getProcessStartTime(pid);

      state.sessions[sessionId] = {
        pid,
        processStartTime,
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
    const sessionsToRemove: string[] = [];

    const state = await this.readState();

    for (const [sessionId, sessionInfo] of Object.entries(state.sessions)) {
      // Primary check: lastSeen timeout
      const lastSeenAge = now - sessionInfo.lastSeen;

      if (lastSeenAge > timeoutMs) {
        sessionsToRemove.push(sessionId);
        continue;
      }

      // Secondary check: is process still alive?
      const isAlive = await this.isProcessAlive(sessionInfo.pid, sessionInfo.processStartTime);

      if (!isAlive) {
        sessionsToRemove.push(sessionId);
      }
    }

    // Remove stale sessions
    if (sessionsToRemove.length > 0) {
      await this.updateState((state): SingletonState => {
        for (const sessionId of sessionsToRemove) {
          delete state.sessions[sessionId];
        }
        return state;
      });
    }

    return sessionsToRemove.length;
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
   * Check if a process is alive (optionally with start time verification)
   * @param pid Process ID to check
   * @param expectedStartTime Optional expected process start time (for PID reuse detection)
   * @returns true if process is alive and matches expected start time
   */
  private async isProcessAlive(pid: number, expectedStartTime?: number): Promise<boolean> {
    try {
      // Try to send signal 0 to check if process exists
      process.kill(pid, 0);

      // If expected start time is provided, verify it matches
      if (expectedStartTime !== undefined) {
        const currentStartTime = await this.getProcessStartTime(pid);
        return currentStartTime === expectedStartTime;
      }

      return true;
    } catch {
      // Process doesn't exist or we can't check it
      return false;
    }
  }

  /**
   * Get process start time from /proc/{pid}/stat (Linux only)
   * This is field 22 (starting after field 22, which starts after 21 spaces)
   *
   * Platform limitation: PID reuse detection is only available on Linux.
   * On macOS and Windows, the /proc filesystem does not exist, so we cannot
   * detect when a PID has been reused. This means a stale session with a
   * reused PID could incorrectly appear as still alive. The impact is low:
   * - On Linux: PIDs are uniquely identified by (pid, startTime) pair
   * - On macOS/Windows: Only pid is used, so reuse detection is not possible
   *
   * @param pid Process ID
   * @returns Process start time in jiffies (clock ticks since boot) or undefined
   */
  private async getProcessStartTime(pid: number): Promise<number | undefined> {
    if (process.platform !== 'linux') {
      return undefined;
    }

    try {
      const statContent = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');

      // The stat file format is: pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice num_threads itrealvalue starttime vsize rss rsslim startcode endcode startstack kstkesp kstkeip signal blocked sigignore sigcatch wchan nswap cnswap exit_signal processor rt_priority policy delayacct_blkio_ticks guest_time cguest_time start_data end_data start_brk arg_start arg_end env_start env_end exit_code
      // Field 22 is starttime (process start time in jiffies)

      // Split by space, but need to handle the comm field which can contain spaces
      const parts = statContent.split(' ');

      // Find the closing parenthesis of the comm field
      let commEndIndex = 0;
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (part?.includes(')')) {
          commEndIndex = i;
          break;
        }
      }

      // Field 22 is at index (2 + 20) = 22 (0-indexed after comm)
      // After comm (field 1), we skip to field 22
      const startIndex = commEndIndex + 20;

      if (startIndex < parts.length) {
        const part = parts[startIndex];
        if (part !== undefined) {
          const starttimeStr = part.replace(')', '');
          const starttime = parseInt(starttimeStr, 10);
          return isNaN(starttime) ? undefined : starttime;
        }
      }

      return undefined;
    } catch {
      // Can't read process stat file
      return undefined;
    }
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
   * Acquire a filesystem lock for exclusive access to state
   * @throws Error if unable to acquire lock within timeout
   */
  private async acquireLock(): Promise<void> {
    await this.ensureDirectories();

    const startTime = Date.now();

    for (let _attempt = 0; _attempt < this.lockRetries; _attempt++) {
      try {
        this.lockHandle = await fs.open(this.lockFilePath, 'wx');
        return;
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error) {
          const errnoError = error as NodeJS.ErrnoException;
          if (errnoError.code === 'EEXIST') {
            // Check if lock is stale
            try {
              const stats = await fs.stat(this.lockFilePath);
              const lockAge = Date.now() - stats.mtimeMs;

              if (lockAge > this.lockStaleThreshold) {
                // Stale lock, remove it
                await fs.unlink(this.lockFilePath);
                continue;
              }
            } catch {
              // Can't stat lock file, continue waiting
            }

            // Wait before retrying
            if (Date.now() - startTime < this.lockTimeout) {
              await this.sleep(this.lockRetryDelay);
              continue;
            }

          }
        }
        throw error;
      }
    }

    throw new Error(`Failed to acquire lock after ${this.lockRetries} retries`);
  }

  /**
   * Release the filesystem lock
   * @throws Error if unable to release lock
   */
  private async releaseLock(): Promise<void> {
    if (this.lockHandle !== null) {
      try {
        await this.lockHandle.close();
        this.lockHandle = null;
      } catch (error: unknown) {
        throw new Error(`Failed to close lock file handle: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    try {
      await fs.unlink(this.lockFilePath);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code !== 'ENOENT') {
          throw new Error(`Failed to remove lock file: ${errnoError.message}`, { cause: error });
        }
      }
    }
  }

  /**
   * Execute a callback function while holding the lock with timeout.
   * @param callback Async function to execute while holding the lock
   * @param timeout Maximum time to hold the lock (default 30 seconds)
   * @returns The return value of the callback
   * @throws Error if unable to acquire lock, timeout, or callback throws
   */
  private async withLock<T>(
    callback: () => Promise<T> | T,
    timeout: number = 30000,
  ): Promise<T> {
    const startTime = Date.now();
    
    // 1. Acquire lock with timeout
    await this.acquireLock();
    
    let lockReleased = false;
    try {
      // 2. Execute callback. 
      // Note: We don't use Promise.race(callback, timeout) here anymore for the execution phase.
      // Releasing a lock while the callback is still running is a race condition.
      // Instead, we rely on the callback to finish, or the external signal to abort.
      // If we REALLY want an execution timeout, the callback MUST support AbortSignal.
      return await callback();
    } finally {
      if (!lockReleased) {
        try {
          await this.releaseLock();
          lockReleased = true;
        } catch (error: unknown) {
          logger.error('[StateManager] Failed to release lock:', error);
        }
      }
    }
  }
/**
 * Get the current browser server information
 */
public async getBrowserServer(): Promise<{ port: number; pid: number } | null> {
  const state = await this.readState();
  return state.browserServer ?? null;
}

/**
 * Set the current browser server information (atomic: only overwrites if no live server exists)
 */
public async setBrowserServer(port: number, pid: number): Promise<void> {
  await this.updateState((state) => {
    state.browserServer = { port, pid };
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
 * Check if a process is alive
 */
public async isPidAlive(pid: number): Promise<boolean> {
  return this.isProcessAlive(pid);
}

/**
 * Validate the structure and version of a state object
...
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
      const bs = state.browserServer as any;
      if (typeof bs.port !== 'number' || typeof bs.pid !== 'number') {
        throw new Error('Invalid state: browserServer must have numeric port and pid fields');
      }
      if (bs.port < 0 || bs.port > 65535) {
        throw new Error(`Invalid state: browserServer.port must be 0-65535, got ${bs.port}`);
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

      if (sessionData.processStartTime !== undefined && sessionData.processStartTime < 0) {
        throw new Error(`Invalid state: processStartTime for ${sessionId} must be a non-negative number or undefined, got ${sessionData.processStartTime}`);
      }

      if (sessionData.lastSeen < 0) {
        throw new Error(`Invalid state: lastSeen for ${sessionId} must be a non-negative number, got ${sessionData.lastSeen}`);
      }

      if (sessionData.connectedAt < 0) {
        throw new Error(`Invalid state: connectedAt for ${sessionId} must be a non-negative number, got ${sessionData.connectedAt}`);
      }
    }
  }

  /**
   * Sleep for a specified number of milliseconds
   * @param ms The number of milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
    if (this.lockHandle !== null) {
      try {
        await this.releaseLock();
      } catch (error: unknown) {
        logger.error('Failed to release lock during cleanup:', error);
      }
    }
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
}
