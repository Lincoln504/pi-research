/**
 * File Lock Service
 *
 * Low-level cross-process file locking primitives with UUID-based ownership.
 * Provides thread-safe and cross-process-safe file locking mechanisms.
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * Lock configuration options
 */
export interface FileLockOptions {
  /** Lock file path */
  lockFilePath: string;
  /** Maximum time to wait for lock acquisition (default: 10 seconds) */
  lockTimeout?: number;
  /** Number of retries for lock acquisition (default: 100) */
  lockRetries?: number;
  /** Delay between retries in milliseconds (default: 100ms) */
  lockRetryDelay?: number;
  /** Stale lock threshold in milliseconds (default: 30 seconds) */
  lockStaleThreshold?: number;
}

/**
 * File Lock Service
 *
 * Provides cross-process file locking with UUID-based ownership verification.
 * Handles stale lock detection and cleanup.
 */
export class FileLockService {
  private readonly lockFilePath: string;
  private readonly lockTimeout: number;
  private readonly lockRetries: number;
  private readonly lockRetryDelay: number;
  private readonly lockStaleThreshold: number;

  // Lock tracking
  private lockHandle: fs.FileHandle | null = null;
  private readonly lockUuid: string = crypto.randomUUID();

  constructor(options: FileLockOptions) {
    this.lockFilePath = options.lockFilePath;
    this.lockTimeout = options.lockTimeout ?? 10000;
    this.lockRetries = options.lockRetries ?? 100;
    this.lockRetryDelay = options.lockRetryDelay ?? 100;
    this.lockStaleThreshold = options.lockStaleThreshold ?? 30000;

    // Clean up any stale locks on initialization (fire and forget)
    this.cleanupStaleLocksOnStartup().catch((error: unknown) => {
      logger.warn(
        '[FileLockService] Failed to cleanup stale locks on startup:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  /**
   * Clean up any stale lock files on initialization.
   * This handles cases where locks weren't released due to crashes.
   */
  private async cleanupStaleLocksOnStartup(): Promise<void> {
    try {
      const stats = await fs.stat(this.lockFilePath);
      const lockAge = Date.now() - stats.mtimeMs;

      // Clean up locks older than stale threshold (30 seconds)
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
   * @throws Error if unable to acquire lock within timeout
   */
  async acquireLock(): Promise<void> {
    const startTime = Date.now();
    let contentionCount = 0;

    for (let _attempt = 0; _attempt < this.lockRetries; _attempt++) {
      try {
        // Open lock file and write UUID immediately (atomic)
        this.lockHandle = await fs.open(this.lockFilePath, 'wx');
        await this.lockHandle.write(this.lockUuid);
        await this.lockHandle.sync(); // Ensure UUID is written to disk

        const duration = Date.now() - startTime;
        metrics.observe('state_lock_acquire_duration_ms', duration);
        metrics.increment('state_lock_acquire_total', 1, { status: 'success' });
        if (contentionCount > 0) {
          metrics.increment('state_lock_contention_total', 1);
          metrics.observe('state_lock_contention_retries', contentionCount);
        }
        return;
      } catch (error: unknown) {
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
                // Check if lock owner is still alive using the UUID
                // This prevents TOCTOU race where a new process might have acquired the lock
                if (lockUuid === this.lockUuid) {
                  // This is our own lock (shouldn't happen, but handle gracefully)
                  return;
                }

                // Stale lock with different UUID - safe to remove
                // Use atomic rename to "claim" the stale lock file before deleting it
                // This prevents deleting a lock that was JUST acquired by another process
                const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
                try {
                  await fs.rename(this.lockFilePath, trashPath);
                  await fs.unlink(trashPath);
                } catch {
                  // Someone else already cleaned it up or acquired it - that's fine
                }
                continue;
              }
            } catch (_statError) {
              // Can't stat or read lock file - try to remove it atomically
              const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
              try {
                await fs.rename(this.lockFilePath, trashPath);
                await fs.unlink(trashPath);
                continue;
              } catch {
                // Lock file might be removed by another process, continue waiting
              }
            }

            // Wait before retrying
            if (Date.now() - startTime < this.lockTimeout) {
              await this.sleep(this.lockRetryDelay);
              continue;
            }
          }
        }
        const duration = Date.now() - startTime;
        metrics.observe('state_lock_acquire_duration_ms', duration, { status: 'timeout' });
        metrics.increment('state_lock_acquire_total', 1, { status: 'timeout' });
        throw error;
      }
    }

    metrics.increment('state_lock_acquire_total', 1, { status: 'failed' });
    throw new Error(`Failed to acquire lock after ${this.lockRetries} retries`);
  }

  /**
   * Release the filesystem lock.
   * @throws Error if unable to release lock
   */
  async releaseLock(): Promise<void> {
    if (this.lockHandle !== null) {
      try {
        // Verify we still own the lock before releasing
        try {
          const lockContent = await fs.readFile(this.lockFilePath, 'utf-8');
          const lockUuid = lockContent.trim();
          if (lockUuid !== this.lockUuid) {
            // Lock was stolen by another process, don't delete
            logger.warn('[FileLockService] Lock UUID mismatch during release, skipping deletion');
            this.lockHandle = null;
            metrics.increment('state_lock_release_total', 1, { status: 'not_owner' });
            return;
          }
        } catch (_readError) {
          // Lock file might already be gone, that's fine
        }

        // Only close if handle exists (might have been set to null above)
        if (this.lockHandle !== null) {
          await this.lockHandle.close();
          this.lockHandle = null;
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