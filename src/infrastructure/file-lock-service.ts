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
import type { IProcessLifecycle } from '../core/interfaces/process-interfaces.ts';

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
  /**
   * Stale threshold (ms) applied ONLY when the lock's owner process is provably
   * alive. Much larger than lockStaleThreshold so a live process holding the lock
   * during a slow critical section (disk stall, fsync) is never stolen from —
   * only reclaimed in the rare PID-reuse case. Default: max(120s, 4×stale).
   */
  liveOwnerStaleThreshold?: number;
  /**
   * Process lifecycle service, used for PID+start-time (PID-reuse-safe) liveness
   * checks. Optional for backward compatibility with direct construction (tests,
   * not-yet-wired call sites): when omitted, liveness falls back to the pre-existing
   * bare `process.kill(pid, 0)` check.
   */
  processLifecycle?: IProcessLifecycle;
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
  private readonly liveOwnerStaleThreshold: number;
  private readonly processLifecycle: IProcessLifecycle | null;

  // Lock tracking
  private lockHandle: fs.FileHandle | null = null;
  private readonly lockUuid: string = crypto.randomUUID();
  private queue: Promise<void> = Promise.resolve();
  private resolveTurn: (() => void) | null = null;
  private lockCount: number = 0;
  // Our own process start time, resolved ONCE in initialize() (may shell out on
  // macOS/Windows) and embedded into every lock we write, so a peer can detect
  // PID reuse. Null when unavailable (no processLifecycle, or lookup failed) —
  // then lock content omits startTime and readers treat us as a legacy owner.
  private ownStartTime: number | null = null;

  constructor(options: FileLockOptions) {
    this.lockFilePath = options.lockFilePath;
    this.lockTimeout = options.lockTimeout ?? 20000;
    this.lockRetries = options.lockRetries ?? 200;
    this.lockRetryDelay = options.lockRetryDelay ?? 100;
    this.lockStaleThreshold = options.lockStaleThreshold ?? 15000;
    this.liveOwnerStaleThreshold =
      options.liveOwnerStaleThreshold ?? Math.max(120000, this.lockStaleThreshold * 4);
    this.processLifecycle = options.processLifecycle ?? null;
  }

  /**
   * Decide whether a contended lock may be reclaimed.
   *   - Dead owner            → reclaim immediately (crash cleanup).
   *   - Legacy lock (no pid)  → reclaim once aged past the normal stale threshold.
   *   - Provably-alive owner  → reclaim ONLY after liveOwnerStaleThreshold, so we
   *                             never steal a lock a live process is actively
   *                             holding during a (possibly slow) critical section.
   *                             Stealing it would let two writers run the same
   *                             read-modify-write and lose an update.
   */
  private async _shouldReclaim(
    pid: number | null,
    startTime: number | null,
    lockAge: number,
    memo?: Map<string, boolean>,
  ): Promise<boolean> {
    if (!(await this._resolveOwnerAlive(pid, startTime, memo))) return true;
    if (pid === null) return lockAge > this.lockStaleThreshold;
    return lockAge > this.liveOwnerStaleThreshold;
  }

  /**
   * Liveness of a contended owner, memoized per acquire() episode. The memo (keyed
   * by pid:startTime) ensures the PID+start-time check — which may spawn a ps/powershell
   * subprocess on macOS/Windows — runs at most ONCE per distinct owner per episode,
   * not once per ~100ms retry tick. A change of owner mid-episode has a different
   * (pid,startTime) key, so it naturally busts the cache and forces a fresh check.
   */
  private async _resolveOwnerAlive(
    pid: number | null,
    startTime: number | null,
    memo?: Map<string, boolean>,
  ): Promise<boolean> {
    if (!memo) return this._isOwnerAlive(pid, startTime);
    const key = `${pid ?? 'null'}:${startTime ?? 'null'}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const alive = await this._isOwnerAlive(pid, startTime);
    memo.set(key, alive);
    return alive;
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

    // Resolve our own start time ONCE, here — never on the hot write path. The
    // lookup may shell out on macOS/Windows; getCurrentProcessStartTime() also
    // caches internally, so this is belt-and-suspenders keeping _makeLockContent
    // fully synchronous. Null on failure → lock content omits startTime.
    if (this.processLifecycle) {
      try {
        this.ownStartTime = await this.processLifecycle.getCurrentProcessStartTime();
      } catch {
        this.ownStartTime = null;
      }
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
      // One-shot memo dedupes the two liveness lookups below (log line + decision).
      const memo = new Map<string, boolean>();
      const ownerAlive = await this._resolveOwnerAlive(parsed?.pid ?? null, parsed?.startTime ?? null, memo);

      if (await this._shouldReclaim(parsed?.pid ?? null, parsed?.startTime ?? null, lockAge, memo)) {
        logger.log(
          `[FileLockService] Cleaning up stale lock file (${Math.round(lockAge / 1000)}s old, owner alive: ${ownerAlive})`
        );
        // The liveness lookups above can take long enough for another process to
        // reclaim the stale lock and write its own fresh one at this path. A bare
        // unlink here would delete that live lock. Rename-to-trash and re-verify
        // the UUID matches what we decided on — same guard as the contended path.
        const expectedUuid = parsed?.uuid ?? '';
        const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
        try {
          await fs.rename(this.lockFilePath, trashPath);
          const trashContent = await fs.readFile(trashPath, 'utf-8');
          const trashParsed = this._parseLockContent(trashContent);
          if ((trashParsed?.uuid ?? '') !== expectedUuid) {
            // Lock changed hands mid-check — restore it and back off.
            try { await fs.link(trashPath, this.lockFilePath); } catch { /* ignore */ }
            await fs.unlink(trashPath);
            return;
          }
          await fs.unlink(trashPath);
          logger.log('[FileLockService] Stale lock removed');
        } catch { /* best-effort startup cleanup; acquire() handles contention */ }
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
    // One entry per distinct (pid,startTime) owner seen during THIS acquireLock()
    // call, so a live contended owner waited out across many ~100ms retry ticks is
    // liveness-checked once, not once per tick (no ps/powershell storm on non-Linux).
    const contendedOwnerAliveMemo = new Map<string, boolean>();

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

                // Reclaim a dead owner's lock immediately; for a provably-alive
                // owner only after the much larger liveOwnerStaleThreshold (see
                // _shouldReclaim). This closes the lost-update window where a peer
                // stole the lock from a live writer stalled >15s mid-fsync. A live
                // owner holding a fresh lock is genuine contention — handled by the
                // surrounding retry loop / timeout, not by stealing.
                if (await this._shouldReclaim(parsed?.pid ?? null, parsed?.startTime ?? null, lockAge, contendedOwnerAliveMemo)) {
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
    const content: { uuid: string; pid: number; startTime?: number } = {
      uuid: this.lockUuid,
      pid: process.pid,
    };
    // Omit (don't null) when unknown, so a legacy reader and a "couldn't resolve"
    // writer both collapse to the same startTime-absent case.
    if (this.ownStartTime !== null) content.startTime = this.ownStartTime;
    return JSON.stringify(content);
  }

  /**
   * Parse lock file content — handles both legacy bare-UUID and new JSON format.
   * Returns null if content is empty or unparseable. A missing/non-number startTime
   * (legacy lock, or a writer that couldn't resolve its own) parses to null.
   */
  private _parseLockContent(content: string): { uuid: string; pid: number | null; startTime: number | null } | null {
    const trimmed = content.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as { uuid?: string; pid?: number; startTime?: number };
      if (typeof parsed.uuid === 'string') {
        return {
          uuid: parsed.uuid,
          pid: typeof parsed.pid === 'number' ? parsed.pid : null,
          startTime: typeof parsed.startTime === 'number' ? parsed.startTime : null,
        };
      }
    } catch {
      // Legacy format: bare UUID string
      return { uuid: trimmed, pid: null, startTime: null };
    }
    return null;
  }

  /**
   * Check whether the process that wrote the lock file is still alive.
   * Returns true (assume alive) if we cannot determine liveness.
   *
   * With processLifecycle wired AND a startTime recorded in the lock, this is a
   * PID-reuse-safe check: a recycled PID whose start time differs from the lock's
   * reads as dead. Without either (no DI, or a legacy/unknown-startTime lock) it
   * degrades to a bare signal(0) check — the exact pre-fix behavior, no subprocess.
   */
  private async _isOwnerAlive(pid: number | null, startTime: number | null): Promise<boolean> {
    if (pid === null) return true; // Legacy/unparseable lock — can't check, assume alive
    if (pid === process.pid) {
      // Same PID as us. Normally that means it's our own lock — but if the lock
      // carries a start time that differs from ours, this PID was RECYCLED and the
      // lock belongs to a dead predecessor, not us. Only assume "alive" when the
      // start times agree (or either is unknown).
      if (startTime !== null && this.ownStartTime !== null) return startTime === this.ownStartTime;
      return true;
    }
    if (!this.processLifecycle) {
      // Not wired for DI (e.g. a bare `new FileLockService(...)`): preserve the
      // original signal(0)-only behavior exactly.
      try { process.kill(pid, 0); return true; } catch { return false; }
    }
    if (startTime === null) {
      // Legacy lock (no startTime) or the peer's own start-time lookup failed:
      // can't assert PID identity, so bare-PID path. isProcessAlive() with no
      // expectedStartTime is signal(0)-only — no subprocess.
      return this.processLifecycle.isProcessAlive(pid);
    }
    // PID-reuse-safe. May shell out on macOS/Windows — the hot contention path
    // reaches this only through the per-episode memo (_resolveOwnerAlive).
    return this.processLifecycle.isProcessAlive(pid, startTime);
  }

  /**
   * Sleep for a specified number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
