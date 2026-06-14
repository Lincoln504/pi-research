/**
 * File Lock Service
 *
 * Low-level cross-process file locking primitives with UUID-based ownership.
 * Provides thread-safe and cross-process-safe file locking mechanisms.
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as pathmod from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { IService } from '../core/service-registry.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

/**
 * Global storage for tracking lock ownership within the same async execution flow.
 * This allows safe re-entrancy (nested locks) while correctly serializing 
 * non-nested concurrent calls on the same instance.
 */
const lockContext = new AsyncLocalStorage<Set<string>>();

/**
 * Lock configuration options
 */
export interface FileLockOptions {
  /** Lock file path */
  lockFilePath: string;
  /** Maximum time to wait for lock acquisition (default: 20 seconds) */
  lockTimeout?: number;
  /** Number of retries for lock acquisition (default: 200) */
  lockRetries?: number;
  /** Delay between retries in milliseconds (default: 100ms) */
  lockRetryDelay?: number;
  /** Stale lock threshold in milliseconds (default: 15 seconds) */
  lockStaleThreshold?: number;
}

/**
 * File Lock Service
 *
 * Provides cross-process file locking with UUID-based ownership verification.
 * Handles stale lock detection and cleanup.
 */
export class FileLockService implements IService {
  readonly name = ServiceNames.FILE_LOCK_SERVICE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;
  private _initialized = false;

  private readonly lockFilePath: string;
  private readonly lockTimeout: number;
  private readonly lockRetries: number;
  private readonly lockRetryDelay: number;
  private readonly lockStaleThreshold: number;

  // Lock tracking
  private lockHandle: fs.FileHandle | null = null;
  private readonly lockUuid: string = crypto.randomUUID();
  private queue: Promise<void> = Promise.resolve();
  private resolveTurn: (() => void) | null = null;
  private lockCount: number = 0;

  constructor(options: FileLockOptions) {
    this.lockFilePath = options.lockFilePath;
    this.lockTimeout = options.lockTimeout ?? 20000;
    this.lockRetries = options.lockRetries ?? 200;
    this.lockRetryDelay = options.lockRetryDelay ?? 100;
    this.lockStaleThreshold = options.lockStaleThreshold ?? 15000;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      return;
    }
    this.lifecycle = ServiceLifecycle.INITIALIZING;

    // Ensure lock directory exists
    try {
      const lockDir = pathmod.dirname(this.lockFilePath);
      await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn(`[FileLockService] Failed to create lock directory: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Clean up any stale locks on initialization (fire and forget)
    await this.cleanupStaleLocksOnStartup();
    this._initialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
  }

  async dispose(): Promise<void> {
    this.lifecycle = ServiceLifecycle.DISPOSING;
    await this.cleanup();
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Clean up any stale lock files on initialization.
   * This handles cases where locks weren't released due to crashes.
   */
  private async cleanupStaleLocksOnStartup(): Promise<void> {
    try {
      const rawContent = await fs.readFile(this.lockFilePath, 'utf-8').catch(() => null);
      if (rawContent === null) return; // No lock file — nothing to do

      const stats = await fs.stat(this.lockFilePath);
      const lockAge = Date.now() - stats.mtimeMs;
      const parsed = this._parseLockContent(rawContent);
      const ownerAlive = this._isOwnerAlive(parsed?.pid ?? null);

      if (!ownerAlive || lockAge > this.lockStaleThreshold) {
        logger.log(
          `[FileLockService] Cleaning up stale lock file (${Math.round(lockAge / 1000)}s old, owner alive: ${ownerAlive})`
        );
        await fs.unlink(this.lockFilePath);
        logger.log('[FileLockService] Stale lock removed');
      }
    } catch (error: unknown) {
      // ENOENT is expected (no lock file exists)
      if (error instanceof Error && 'code' in error) {
        const errnoError = error as NodeJS.ErrnoException;
        if (errnoError.code !== 'ENOENT') {
          logger.warn(`[FileLockService] Could not check lock file: ${errnoError.message}`);
        }
      }
    }
  }

  /**
   * Acquire a filesystem lock for exclusive access.
   * Supports re-entrancy (recursive locking) within the same async execution context.
   * @throws Error if unable to acquire lock within timeout
   */
  async acquireLock(): Promise<void> {
    const heldLocks = lockContext.getStore();
    const lockKey = `${this.lockFilePath}:${this.lockUuid}`;

    // 0. Support re-entrancy: check if the current async flow already holds this lock instance.
    if (heldLocks?.has(lockKey)) {
      if (this.lockHandle !== null) {
        this.lockCount++;
        return;
      }
    }

    // 1. Join the local FIFO queue for this instance.
    // This ensures that multiple concurrent calls to acquireLock() on the same
    // instance (e.g. from different queries in the same process) are handled
    // one by one, preventing internal state corruption and redundant disk I/O.
    let myResolve!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      myResolve = resolve;
    });

    const previous = this.queue;
    this.queue = myTurn;

    try {
      await previous;
    } catch (_err) {
      // Continue even if previous turn failed
    }

    // Secondary re-entrancy check: if a previous turn in the queue already
    // acquired the lock for us (e.g. nested call that bypassed the queue).
    if (heldLocks?.has(lockKey) && this.lockHandle !== null) {
      this.lockCount++;
      // Release our turn immediately so the next caller can proceed.
      if (myResolve) myResolve();
      return;
    }

    // Capture resolve function so we can trigger it in releaseLock() or on failure
    this.resolveTurn = myResolve;

    const startTime = Date.now();
    let contentionCount = 0;

    try {
      for (let _attempt = 0; _attempt < this.lockRetries; _attempt++) {
        // Use a LOCAL handle variable so that concurrent acquireLock() calls on
        // the same instance cannot close each other's file handle through the
        // shared this.lockHandle field. We only promote to this.lockHandle after
        // the lock is fully and successfully acquired.
        let handle: fs.FileHandle | null = null;
        try {
          // Open lock file and write owner identity immediately (atomic)
          handle = await fs.open(this.lockFilePath, 'wx', 0o600);
          await handle.write(this._makeLockContent());
          await handle.sync(); // Ensure content is written to disk

          // Fully acquired — commit to instance state
          this.lockHandle = handle;
          this.lockCount = 1;

          // Track in ALS for nested calls
          if (heldLocks) {
            heldLocks.add(lockKey);
          }

          const duration = Date.now() - startTime;
          metrics.observe('state_lock_acquire_duration_ms', duration);
          metrics.increment('state_lock_acquire_total', 1, { status: 'success' });
          metrics.setGauge('state_lock_held', 1);
          if (contentionCount > 0) {
            metrics.increment('state_lock_contention_total', 1);
            metrics.observe('state_lock_contention_retries', contentionCount);
          }
          return;
        } catch (error: unknown) {
          // Close the locally-opened handle only (never touch this.lockHandle here)
          if (handle) {
            try {
              await handle.close();
            } catch {
              // Ignore close error
            }
            // If we successfully opened the file but failed to write/sync,
            // we should try to unlink it so other processes aren't blocked
            // by a partial/empty lock file.
            try {
              await fs.unlink(this.lockFilePath);
            } catch {
              // Ignore unlink error
            }
          }

          if (error instanceof Error && 'code' in error) {
            const errnoError = error as NodeJS.ErrnoException;
            if (errnoError.code === 'EEXIST') {
              contentionCount++;
              // Read lock content to verify ownership and liveness before considering stale
              try {
                const rawContent = await fs.readFile(this.lockFilePath, 'utf-8');
                const parsed = this._parseLockContent(rawContent);
                const lockUuid = parsed?.uuid ?? '';
                const stats = await fs.stat(this.lockFilePath);
                const lockAge = Date.now() - stats.mtimeMs;

                if (lockUuid === this.lockUuid) {
                  // This is our own lock — a previous attempt was interrupted. Reclaim.
                  try { await fs.unlink(this.lockFilePath); } catch { /* ignore */ }
                  continue;
                }

                // Reclaim immediately if the owner process is dead (PID-liveness check).
                // Fall through to mtime-staleness only for processes that appear alive.
                const ownerAlive = this._isOwnerAlive(parsed?.pid ?? null);
                if (!ownerAlive || lockAge > this.lockStaleThreshold) {
                  if (ownerAlive && lockAge <= this.lockStaleThreshold) {
                    // Alive but not stale — genuine contention, keep waiting
                  } else {
                    const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
                    try {
                      await fs.rename(this.lockFilePath, trashPath);
                      const trashContent = await fs.readFile(trashPath, 'utf-8');
                      const trashParsed = this._parseLockContent(trashContent);
                      if ((trashParsed?.uuid ?? '') !== lockUuid) {
                        try { await fs.link(trashPath, this.lockFilePath); } catch { /* ignore */ }
                        await fs.unlink(trashPath);
                        continue;
                      }
                      await fs.unlink(trashPath);
                    } catch { /* ignore */ }
                    continue;
                  }
                }
              } catch (_statError) {
                const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
                try {
                  await fs.rename(this.lockFilePath, trashPath);
                  await fs.unlink(trashPath);
                  continue;
                } catch { /* ignore */ }
              }

              if (Date.now() - startTime >= this.lockTimeout) {
                const duration = Date.now() - startTime;
                metrics.observe('state_lock_acquire_duration_ms', duration, { status: 'timeout' });
                metrics.increment('state_lock_acquire_total', 1, { status: 'timeout' });
                throw new Error(
                  `Failed to acquire lock at ${this.lockFilePath}: timeout after ${this.lockTimeout}ms`,
                  { cause: error },
                );
              }

              await this.sleep(this.lockRetryDelay);
              continue;
            }
          }
          throw error;
        }
      }

      metrics.increment('state_lock_acquire_total', 1, { status: 'failed' });
      throw new Error(`Failed to acquire lock after ${this.lockRetries} retries`);
    } catch (err) {
      // If acquisition failed (timeout/error), we MUST release our turn in the 
      // queue so the next caller can try.
      if (this.resolveTurn) {
        this.resolveTurn();
        this.resolveTurn = null;
      }
      throw err;
    }
  }

  /**
   * Release the filesystem lock.
   */
  async releaseLock(): Promise<void> {
    if (this.lockHandle === null) {
      return;
    }

    this.lockCount--;
    if (this.lockCount > 0) {
      return;
    }

    try {
      // 1. Double check ownership before unlinking
      const content = await fs.readFile(this.lockFilePath, 'utf8').catch(() => '');
      const parsed = this._parseLockContent(content);
      if (parsed?.uuid === this.lockUuid) {
        await fs.unlink(this.lockFilePath).catch(() => {});
      }
      
      // 2. Clean up handle
      await this.lockHandle.close().catch(() => {});
      this.lockHandle = null;
      this.lockCount = 0;

      // 3. Remove from ALS
      const heldLocks = lockContext.getStore();
      if (heldLocks) {
        heldLocks.delete(`${this.lockFilePath}:${this.lockUuid}`);
      }

      metrics.setGauge('state_lock_held', 0);
    } finally {
      // 4. Signal the next caller in the queue that it's their turn.
      const resolve = this.resolveTurn;
      this.resolveTurn = null;
      if (resolve) {
        resolve();
      }
    }
  }

  /**
   * Execute a function within the scope of a filesystem lock.
   * This is the preferred way to use the lock service.
   * Safe re-entrancy is supported within the same async flow.
   */
  async withLock<T>(callback: () => Promise<T> | T, _timeout: number = 30000): Promise<T> {
    const heldLocks = lockContext.getStore();
    const lockKey = `${this.lockFilePath}:${this.lockUuid}`;

    // If we already hold this lock instance in this async flow, just call the callback
    if (heldLocks?.has(lockKey)) {
      return await callback();
    }

    // Otherwise, create a new context (if none exists) and acquire the lock
    return await lockContext.run(heldLocks || new Set<string>(), async () => {
      await this.acquireLock();
      try {
        return await callback();
      } finally {
        await this.releaseLock();
      }
    });
  }

  /**
   * Force clean up any lock files owned by this instance.
   */
  async cleanup(): Promise<void> {
    if (this.lockHandle) {
      try {
        const content = await fs.readFile(this.lockFilePath, 'utf8').catch(() => '');
        const parsed = this._parseLockContent(content);
        if (parsed?.uuid === this.lockUuid) {
          await fs.unlink(this.lockFilePath).catch(() => {});
        }
      } catch { /* ignore */ }
      try {
        await this.lockHandle.close();
      } catch { /* ignore */ }
      this.lockHandle = null;
    }
    this.lockCount = 0;
  }

  /**
   * Check if the current instance holds the lock
   */
  isLocked(): boolean {
    return this.lockHandle !== null;
  }

  /**
   * Get the UUID for this service instance
   */
  getLockUuid(): string {
    return this.lockUuid;
  }

  /**
   * Encode the lock file content with owner identity for liveness checks.
   */
  private _makeLockContent(): string {
    return JSON.stringify({ uuid: this.lockUuid, pid: process.pid });
  }

  /**
   * Parse lock file content — handles both legacy bare-UUID and new JSON format.
   * Returns null if content is empty or unparseable.
   */
  private _parseLockContent(content: string): { uuid: string; pid: number | null } | null {
    const trimmed = content.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as { uuid?: string; pid?: number };
      if (typeof parsed.uuid === 'string') {
        return { uuid: parsed.uuid, pid: typeof parsed.pid === 'number' ? parsed.pid : null };
      }
    } catch {
      // Legacy format: bare UUID string
      return { uuid: trimmed, pid: null };
    }
    return null;
  }

  /**
   * Check whether the process that wrote the lock file is still alive.
   * Returns true (assume alive) if we cannot determine liveness.
   */
  private _isOwnerAlive(pid: number | null): boolean {
    if (pid === null) return true; // Legacy lock — can't check, assume alive
    if (pid === process.pid) return true; // Our own PID
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sleep for a specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
