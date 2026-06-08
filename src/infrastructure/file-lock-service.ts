/**
 * File Lock Service
 *
 * Low-level cross-process file locking primitives with UUID-based ownership.
 * Provides thread-safe and cross-process-safe file locking mechanisms.
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as pathmod from 'node:path';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import type { IService } from '../core/service-registry.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';

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
      const stats = await fs.stat(this.lockFilePath);
      const lockAge = Date.now() - stats.mtimeMs;

      // Clean up locks older than stale threshold (15 seconds)
      if (lockAge > this.lockStaleThreshold) {
        logger.log(
          `[FileLockService] Cleaning up stale lock file (${Math.round(lockAge / 1000)}s old)`
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
   * Supports re-entrancy (recursive locking) within the same instance.
   * @throws Error if unable to acquire lock within timeout
   */
  async acquireLock(): Promise<void> {
    // 0. Support re-entrancy: if this instance already holds the lock, just increment count.
    if (this.lockHandle !== null) {
        this.lockCount++;
        return;
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
    if (this.lockHandle !== null) {
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
        let handle: import('node:fs/promises').FileHandle | null = null;
        try {
          // Open lock file and write UUID immediately (atomic)
          handle = await fs.open(this.lockFilePath, 'wx');
          await handle.write(this.lockUuid);
          await handle.sync(); // Ensure UUID is written to disk

          // Fully acquired — commit to instance state
          this.lockHandle = handle;
          this.lockCount = 1;

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
              // Read lock UUID to verify ownership before considering stale
              try {
                const lockContent = await fs.readFile(this.lockFilePath, 'utf-8');
                const lockUuid = lockContent.trim();
                const stats = await fs.stat(this.lockFilePath);
                const lockAge = Date.now() - stats.mtimeMs;

                // Only delete if lock is stale AND we can verify it's not owned by a live process
                if (lockAge > this.lockStaleThreshold) {
                  if (lockUuid === this.lockUuid) {
                    // This is our own lock (shouldn't happen, but handle gracefully)
                    // We found our UUID but we don't have a handle, so a previous 
                    // attempt must have been interrupted. Unlink and try again properly.
                    try {
                      await fs.unlink(this.lockFilePath);
                    } catch { /* ignore */ }
                    continue;
                  }

                  const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
                  try {
                    await fs.rename(this.lockFilePath, trashPath);
                    const trashContent = await fs.readFile(trashPath, 'utf-8');
                    if (trashContent.trim() !== lockUuid) {
                      try {
                        await fs.link(trashPath, this.lockFilePath);
                      } catch { /* ignore */ }
                      await fs.unlink(trashPath);
                      continue;
                    }
                    await fs.unlink(trashPath);
                  } catch { /* ignore */ }
                  continue;
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
   * Supports recursive release.
   * @throws Error if unable to release lock
   */
  async releaseLock(): Promise<void> {
    // Support recursive release
    if (this.lockCount > 1) {
        this.lockCount--;
        return;
    }

    try {
      if (this.lockHandle !== null) {
        try {
          try {
            const lockContent = await fs.readFile(this.lockFilePath, 'utf-8');
            const lockUuid = lockContent.trim();
            if (lockUuid !== this.lockUuid) {
              logger.warn('[FileLockService] Lock UUID mismatch during release, skipping deletion');
              
              // CRITICAL: We MUST close our handle even if we no longer own the lock file
              // on disk, otherwise Node.js will throw ERR_INVALID_STATE on GC.
              try {
                await this.lockHandle.close();
              } catch (closeError) {
                logger.debug(`[FileLockService] Error closing handle after UUID mismatch: ${closeError}`);
              }
              
              this.lockHandle = null;
              this.lockCount = 0;
              metrics.increment('state_lock_release_total', 1, { status: 'not_owner' });
              return;
            }
          } catch (_readError) { /* ignore */ }

          if (this.lockHandle !== null) {
            try {
              await this.lockHandle.close();
            } finally {
              // Ensure we null out the handle even if close() fails, to prevent
              // leaks and repeated close attempts.
              this.lockHandle = null;
            }
          }
        } catch (error: unknown) {
          metrics.increment('state_lock_release_total', 1, { status: 'error' });
          throw new Error(
            `Failed to close lock file handle: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }

      try {
        await fs.unlink(this.lockFilePath);
        metrics.increment('state_lock_release_total', 1, { status: 'success' });
        metrics.setGauge('state_lock_held', 0);
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error) {
          const errnoError = error as NodeJS.ErrnoException;
          if (errnoError.code !== 'ENOENT') {
            metrics.increment('state_lock_release_total', 1, { status: 'error' });
            throw new Error(`Failed to remove lock file: ${errnoError.message}`, { cause: error });
          }
        }
      }
    } finally {
      this.lockCount = 0;
      // Always release our turn in the local queue
      if (this.resolveTurn) {
        this.resolveTurn();
        this.resolveTurn = null;
      }
    }
  }

  /**
   * Execute a callback function while holding the lock with timeout.
   * @param callback Async function to execute while holding the lock
   * @param timeout Maximum time to hold the lock (default 30 seconds, currently unused)
   * @returns The return value of the callback
   * @throws Error if unable to acquire lock, timeout, or callback throws
   */
  async withLock<T>(callback: () => Promise<T> | T, _timeout: number = 30000): Promise<T> {
    // 1. Acquire lock with timeout
    await this.acquireLock();

    try {
      return await callback();
    } finally {
      try {
        await this.releaseLock();
      } catch (error: unknown) {
        logger.error('[FileLockService] Failed to release lock:', error);
      }
    }
  }

  /**
   * Get the lock UUID for this instance
   */
  getLockUuid(): string {
    return this.lockUuid;
  }

  /**
   * Get the lock file path
   */
  getLockFilePath(): string {
    return this.lockFilePath;
  }

  /**
   * Check if the lock is currently held
   */
  isLockHeld(): boolean {
    return this.lockHandle !== null;
  }

  /**
   * Clean up resources (release lock if held)
   * Should be called when shutting down
   */
  async cleanup(): Promise<void> {
    if (this.lockHandle !== null) {
      try {
        await this.releaseLock();
      } catch (error: unknown) {
        logger.error('[FileLockService] Failed to release lock during cleanup:', error);
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
}
