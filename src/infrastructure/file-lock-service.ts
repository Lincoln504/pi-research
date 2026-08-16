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
 * How long cleanup() waits for an in-flight critical section to release normally
 * before forcing the teardown. Long enough for an ordinary state write (temp file
 * + fsync + rename) to finish, short enough that shutdown still makes progress
 * when the holder is wedged.
 */
const CLEANUP_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Age past which an orphaned `<lock>.trash.<hex>` copy is swept at startup. An
 * in-flight trash-and-verify holds its copy for milliseconds; anything this old
 * was leaked by a crash mid-dance.
 */
const TRASH_SWEEP_AGE_MS = 10 * 60_000;

/**
 * Floor for the held-lock mtime heartbeat interval (see _startHeartbeat), so a
 * small liveOwnerStaleThreshold cannot turn maintenance into a utimes storm.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 2_000;

/**
 * Ceiling on how long a lock whose owner cannot be identified is left alone.
 *
 * Such a lock is treated as live (we could not prove otherwise), but "treated as
 * live" must not mean "immortal" — see _shouldReclaim for why the never-steal
 * opt-out would otherwise strand a run slot permanently.
 */
const UNIDENTIFIED_MAX_STALE_MS = 10 * 60_000;

/**
 * Absolute ceiling on one acquireLock() wait, however healthy the holder looks.
 *
 * `lockTimeout` bounds a STALL — time in which the lock did not change hands and
 * its holder did not refresh it. It deliberately does not bound a wait behind a
 * holder that is visibly working, because that turned ordinary contention into
 * failed runs: the knowledge-store init lock allowed 20s while the same lock
 * covers a post-run FTS rebuild plus optimize, so a second run starting during
 * another's housekeeping failed outright. Twice, on 2026-08-14. Widening the
 * constant is the fix that does not work — housekeeping has no fixed duration.
 *
 * This ceiling is what keeps "wait while progress is happening" from meaning
 * "wait forever" under sustained contention, where the lock keeps changing hands
 * and every observation looks like progress while this caller never wins.
 */
export const LOCK_ACQUIRE_CEILING_MS = 5 * 60_000;

/** setTimeout/setInterval clamp delays above 2^31-1 to 1ms — treat anything
 *  bigger as "no heartbeat" rather than a busy-loop. */
const MAX_TIMER_DELAY_MS = 0x7fffffff;

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
   * Absolute ceiling on one acquireLock() wait, however healthy the holder looks
   * (default: LOCK_ACQUIRE_CEILING_MS). `lockTimeout` bounds a stall; this bounds
   * the total. Exposed so the bound is reachable in a test — a five-minute
   * backstop that no test can drive is a five-minute backstop nobody has checked.
   */
  acquireCeilingMs?: number;
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
  private readonly acquireCeilingMs: number;
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
  // Set by cleanup(). A retired instance no longer manages the lock file, so
  // acquiring through it would hand out exclusivity it cannot honour.
  private _retired = false;
  // Refreshes the held lock file's mtime while a critical section runs (see
  // _startHeartbeat). Null whenever no lock is held.
  private heartbeatTimer: NodeJS.Timeout | null = null;
  // Stable short lock identity for metrics labels — without it every instance
  // (state lock, knowledge init, browser init, run slots) shares one gauge and
  // any release zeroes it globally.
  private readonly lockName: string;

  constructor(options: FileLockOptions) {
    this.lockFilePath = options.lockFilePath;
    this.lockName = pathmod.basename(options.lockFilePath);
    this.lockTimeout = options.lockTimeout ?? 20000;
    this.lockRetries = options.lockRetries ?? 200;
    this.lockRetryDelay = options.lockRetryDelay ?? 100;
    this.lockStaleThreshold = options.lockStaleThreshold ?? 15000;
    this.liveOwnerStaleThreshold =
      options.liveOwnerStaleThreshold ?? Math.max(120000, this.lockStaleThreshold * 4);
    this.acquireCeilingMs = options.acquireCeilingMs ?? LOCK_ACQUIRE_CEILING_MS;
    this.processLifecycle = options.processLifecycle ?? null;
  }

  /**
   * Decide whether a contended lock may be reclaimed.
   *   - Dead owner              → reclaim immediately (crash cleanup).
   *   - Provably-alive owner    → reclaim ONLY after liveOwnerStaleThreshold, so we
   *                               never steal a lock a live process is actively
   *                               holding during a (possibly slow) critical section.
   *                               Stealing it would let two writers run the same
   *                               read-modify-write and lose an update.
   *   - Unidentifiable (no pid) → as patient as a live owner, but never longer
   *                               than UNIDENTIFIED_MAX_STALE_MS.
   *
   * That last case used to take the SHORT threshold, which put it on the
   * crash-cleanup schedule on the strength of no evidence at all — while
   * `_isOwnerAlive(null)` returns true, so the two halves openly disagreed. The
   * forensic cost was the worse half: the reclaim log then read
   * "Cleaning up stale lock file (90s old, owner alive: true)", a sentence that
   * describes stealing a lock from a living process, which is the one thing this
   * class exists not to do.
   *
   * Both halves now agree that unknown means alive. The ceiling exists because the
   * other direction leaks: the run semaphore opts out of live-owner reclaim
   * entirely (MAX_SAFE_INTEGER) so a minutes-long run is never evicted from its
   * slot, and without a bound an unreadable slot file would hold that slot for the
   * life of the machine. Ten minutes is far past any legitimate write window and
   * far short of anything a user would wait out.
   */
  private async _shouldReclaim(
    pid: number | null,
    startTime: number | null,
    lockAge: number,
    memo?: Map<string, boolean>,
  ): Promise<boolean> {
    if (!(await this._resolveOwnerAlive(pid, startTime, memo))) return true;
    if (pid === null) return lockAge > Math.min(this.liveOwnerStaleThreshold, UNIDENTIFIED_MAX_STALE_MS);
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
   * Put a lock file back after a trash-and-verify decided not to reclaim it.
   *
   * The old form linked it back inside a swallowing catch and then unlinked the
   * trash copy unconditionally — so any link failure other than "a peer already
   * re-created it" DESTROYED the lock this branch exists to preserve. Distinguish
   * the two: if the path is occupied again the peer's lock wins and ours is dropped;
   * otherwise move ours back rather than deleting it.
   */
  private async _restoreLockFile(trashPath: string): Promise<void> {
    try {
      await fs.link(trashPath, this.lockFilePath);
      await fs.unlink(trashPath).catch(() => { /* link succeeded; copy is redundant */ });
      return;
    } catch { /* fall through to the two cases below */ }

    const peerHoldsIt = await fs.access(this.lockFilePath).then(() => true).catch(() => false);
    if (peerHoldsIt) {
      // Someone re-created the lock while we were checking. Theirs is authoritative.
      await fs.unlink(trashPath).catch(() => { /* best effort */ });
      return;
    }
    // Nothing there and link failed (EPERM, filesystems without hardlinks,
    // Windows link limits): re-create the path EXCLUSIVELY rather than rename it
    // back — rename silently REPLACES a lock a peer creates between the probe
    // above and now, clobbering a live owner. 'wx' loses that race loudly, and
    // then the peer's lock is authoritative.
    try {
      const content = await fs.readFile(trashPath, 'utf-8');
      const handle = await fs.open(this.lockFilePath, 'wx', 0o600);
      try {
        await handle.write(content);
        await handle.sync();
      } finally {
        await handle.close().catch(() => { /* content is on disk */ });
      }
      await fs.unlink(trashPath).catch(() => { /* restored; copy is redundant */ });
    } catch {
      // EEXIST (a peer took the path) — ours is redundant; anything else, leave
      // the trash copy for the startup sweep. Never delete what we could not
      // put back.
      const occupied = await fs.access(this.lockFilePath).then(() => true).catch(() => false);
      if (occupied) await fs.unlink(trashPath).catch(() => { /* best effort */ });
    }
  }

  /**
   * Hand our turn back to the next caller in the FIFO queue.
   *
   * Every path that stops holding the lock must run this, including the ones that
   * find the handle already gone. `acquireLock` parks on `await previous` with no
   * timeout of its own — the lockTimeout only starts counting once the turn has
   * been granted — so a turn that is never resolved is not a slow acquire, it is a
   * permanent one.
   */
  private _releaseTurn(): void {
    const resolve = this.resolveTurn;
    this.resolveTurn = null;
    if (resolve) resolve();
  }

  /**
   * While the lock is HELD, refresh its mtime on an interval well inside
   * liveOwnerStaleThreshold. Peers judge a live owner purely by lock-file age
   * (_shouldReclaim), and nothing else touches the file during a critical
   * section — so without a heartbeat a legitimately long one (e.g. a multi-minute
   * knowledge-store model-change migration under the 240s init-lock threshold)
   * ages past the limit and is stolen from a LIVE owner, admitting a concurrent
   * writer. With the heartbeat, a live owner is only stolen after genuinely
   * wedging: no refresh for the full threshold.
   *
   * unref() is CORRECT here, unlike a timer that IS the operation: the heartbeat
   * is maintenance on behalf of a critical section that keeps the process alive
   * by itself, and the process must never be kept alive just to freshen a lock.
   *
   * The refresh goes through the held FileHandle (futimes), not the path, so if
   * the lock changed hands (renamed/unlinked by a reclaiming peer) we can only
   * ever touch OUR old inode — never freshen a peer's lock by mistake.
   */
  private _startHeartbeat(): void {
    this._stopHeartbeat();
    const interval = Math.max(HEARTBEAT_MIN_INTERVAL_MS, Math.ceil(this.liveOwnerStaleThreshold / 4));
    // An effectively-infinite threshold (the run-semaphore's never-steal-from-a-
    // live-owner opt-out) needs no heartbeat — and would overflow the 32-bit
    // timer delay, which Node clamps to 1ms (a utimes busy-loop). Skip entirely;
    // the opt-out's semantics are unchanged.
    if (interval > MAX_TIMER_DELAY_MS) return;
    this.heartbeatTimer = setInterval(() => {
      const handle = this.lockHandle;
      if (handle === null) return;
      const now = new Date();
      handle.utimes(now, now).catch(() => { /* best-effort maintenance */ });
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Wait, bounded, for an in-flight critical section to finish.
   *
   * Yanking a held lock is not a clean teardown: unlinking the file while the
   * holder is still mid read-modify-write drops cross-process exclusion, and a peer
   * that acquires in that window loses the holder's update — precisely the hazard
   * the lock exists to prevent. Since every caller of {@link cleanup} is a shutdown
   * path, waiting briefly for a normal release is both safe and correct.
   *
   * Bounded because shutdown must make progress regardless: if the holder is wedged
   * (or is itself the caller, which would otherwise deadlock), we give up and force
   * the teardown, which is the pre-existing behaviour.
   */
  private async _drainHeldLock(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.lockHandle !== null && Date.now() < deadline) {
      await this.sleep(Math.min(25, this.lockRetryDelay));
    }
    return this.lockHandle === null;
  }

  /**
   * Clean up any stale lock files on initialization.
   * This handles cases where locks weren't released due to crashes.
   */
  private async cleanupStaleLocksOnStartup(): Promise<void> {
    // Sweep trash copies leaked by an interrupted trash-and-verify (a crash or
    // I/O failure between the rename and the unlink/restore). Nothing else ever
    // collects them: the state-dir orphan sweep matches only *.tmp files. The age
    // gate is generous — an in-flight reclaim's trash copy lives for milliseconds,
    // and a restore-worthy one is put back on the same code path that made it.
    try {
      const dir = pathmod.dirname(this.lockFilePath);
      const prefix = `${pathmod.basename(this.lockFilePath)}.trash.`;
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(prefix)) continue;
        const p = pathmod.join(dir, name);
        const st = await fs.stat(p).catch(() => null);
        if (st && Date.now() - st.mtimeMs > TRASH_SWEEP_AGE_MS) {
          await fs.unlink(p).catch(() => { /* best effort */ });
        }
      }
    } catch { /* best-effort hygiene; never blocks startup */ }

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
        // Name the lock and say what was actually known about its owner. The old
        // line printed "owner alive: true" for a lock with no readable pid —
        // because unknown owners report as alive — so the reclaim read as a steal
        // from a living process, and it named no path, in a log every concurrent
        // process shares.
        const owner = parsed?.pid == null
          ? 'owner unidentifiable (unreadable lock content)'
          : `owner pid ${parsed.pid} ${ownerAlive ? 'alive but silent' : 'gone'}`;
        logger.log(
          `[FileLockService] Reclaiming ${this.lockName} — untouched for ${Math.round(lockAge / 1000)}s, ${owner}`
        );
        // The liveness lookups above can take long enough for another process to
        // reclaim the stale lock and write its own fresh one at this path. A bare
        // unlink here would delete that live lock. Rename-to-trash and re-verify
        // the UUID matches what we decided on — same guard as the contended path.
        const expectedUuid = parsed?.uuid ?? '';
        const trashPath = `${this.lockFilePath}.trash.${crypto.randomBytes(8).toString('hex')}`;
        let renamed = false;
        try {
          await fs.rename(this.lockFilePath, trashPath);
          renamed = true;
          const trashContent = await fs.readFile(trashPath, 'utf-8');
          const trashParsed = this._parseLockContent(trashContent);
          if ((trashParsed?.uuid ?? '') !== expectedUuid) {
            // Lock changed hands mid-check — restore it and back off.
            await this._restoreLockFile(trashPath);
            return;
          }
          await fs.unlink(trashPath).catch(() => { /* leaked copy; the sweep above collects it */ });
          logger.log(`[FileLockService] Reclaimed ${this.lockName}`);
        } catch {
          // A failure AFTER the rename means the verify never ran — restore
          // rather than leave the (possibly live) lock destroyed in the trash.
          if (renamed) await this._restoreLockFile(trashPath);
          /* otherwise best-effort startup cleanup; acquire() handles contention */
        }
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
    if (this._retired) {
      throw new Error(`Cannot acquire lock at ${this.lockFilePath}: service has been disposed`);
    }
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

    // Re-check after the wait: cleanup() may have retired the instance while we
    // were queued. Hand the turn straight on rather than acquiring a lock file this
    // instance no longer owns.
    if (this._retired) {
      myResolve();
      throw new Error(`Cannot acquire lock at ${this.lockFilePath}: service was disposed while queued`);
    }

    // Capture resolve function so we can trigger it in releaseLock() or on failure
    this.resolveTurn = myResolve;

    const startTime = Date.now();
    // Last moment the contended lock demonstrably moved: it changed hands, or its
    // holder refreshed the mtime its heartbeat maintains. `lockTimeout` is measured
    // from here rather than from startTime, so waiting behind work in progress is
    // free and only a genuinely motionless lock times out.
    let lastProgressAt = startTime;
    let lastSeenUuid: string | null = null;
    let lastSeenMtime = 0;
    let contentionCount = 0;
    // One entry per distinct (pid,startTime) owner seen during THIS acquireLock()
    // call, so a live contended owner waited out across many ~100ms retry ticks is
    // liveness-checked once, not once per tick (no ps/powershell storm on non-Linux).
    const contendedOwnerAliveMemo = new Map<string, boolean>();

    // `lockRetries` was sized to expire at roughly the same moment as the old
    // elapsed-time timeout (200 x 100ms = 20s), so leaving it alone would cap the
    // progress-aware wait right back at the bound it replaces. A try-take
    // (lockTimeout 0) keeps its configured count exactly: the run semaphore sizes
    // it to complete a dead-owner reclaim and reacquire, and must still fail fast.
    const maxAttempts = this.lockTimeout === 0
      ? this.lockRetries
      : this.lockRetries + Math.ceil(this.acquireCeilingMs / Math.max(1, this.lockRetryDelay));

    try {
      for (let _attempt = 0; _attempt < maxAttempts; _attempt++) {
        // Bound EVERY iteration, not just the ones that reach the timeout check
        // below: the reclaim branches `continue` without sleeping, so a lock that
        // kept changing hands could otherwise spin here indefinitely.
        if (this.lockTimeout > 0 && Date.now() - startTime >= this.acquireCeilingMs) {
          metrics.increment('state_lock_acquire_total', 1, { status: 'timeout' });
          throw new Error(
            `Failed to acquire lock at ${this.lockFilePath}: gave up after ${Date.now() - startTime}ms of contention (ceiling ${this.acquireCeilingMs}ms)`,
          );
        }
        // cleanup() can retire the instance while we are contending here — its
        // drain polls only the HELD handle, so a caller mid-retry (holding
        // nothing yet) is invisible to it and would otherwise win the lock and
        // run its critical section against torn-down services after dispose
        // resolved. The queued-waiter check above cannot catch this: our turn was
        // granted before retirement. Abort; the catch below hands the turn on.
        if (this._retired) {
          throw new Error(`Cannot acquire lock at ${this.lockFilePath}: service was disposed during acquisition`);
        }
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

          // Retirement may have landed between the open above and this commit.
          // cleanup()'s drain saw no held handle and already returned, so nothing
          // would ever tear this acquisition down. Throwing here lets the catch
          // below close the handle and remove the just-created lock file.
          if (this._retired) {
            throw new Error(`Cannot acquire lock at ${this.lockFilePath}: service was disposed during acquisition`);
          }

          // Fully acquired — commit to instance state
          this.lockHandle = handle;
          this.lockCount = 1;
          // Keep the held lock's mtime fresh so a long critical section is not
          // mistaken for a wedged owner and stolen (see _startHeartbeat).
          this._startHeartbeat();

          // Track in ALS for nested calls
          if (heldLocks) {
            heldLocks.add(lockKey);
          }

          const duration = Date.now() - startTime;
          metrics.observe('state_lock_acquire_duration_ms', duration);
          metrics.increment('state_lock_acquire_total', 1, { status: 'success' });
          metrics.setGauge('state_lock_held', 1, { lock: this.lockName });
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

                // Progress: a different owner than last time, or the same owner's
                // heartbeat freshening the file. Either way the system is moving and
                // this wait is queueing, not hanging.
                if (lastSeenUuid !== null && (lockUuid !== lastSeenUuid || stats.mtimeMs > lastSeenMtime)) {
                    lastProgressAt = Date.now();
                }
                lastSeenUuid = lockUuid;
                lastSeenMtime = stats.mtimeMs;

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
                  let renamed = false;
                  try {
                    await fs.rename(this.lockFilePath, trashPath);
                    renamed = true;
                    const trashContent = await fs.readFile(trashPath, 'utf-8');
                    const trashParsed = this._parseLockContent(trashContent);
                    if ((trashParsed?.uuid ?? '') !== lockUuid) {
                      await this._restoreLockFile(trashPath);
                      continue;
                    }
                    await fs.unlink(trashPath).catch(() => { /* leaked copy; startup sweep collects it */ });
                  } catch {
                    // Rename failed (nothing moved) — retry handles it. But a read
                    // failure AFTER the rename means the verify never ran: the lock
                    // may have changed hands to a live peer mid-check, and leaving
                    // it in the trash destroys it unverified — the same transient
                    // classes (EMFILE, EACCES, EBUSY) the inspect branch below
                    // backs off for. Put it back instead.
                    if (renamed) await this._restoreLockFile(trashPath);
                  }
                  continue;
                }
              } catch (inspectError) {
                // We could not READ the lock, which says nothing about whether its
                // owner is alive. Destroying it here — as this branch used to,
                // with neither a UUID check nor a liveness check, unlike the
                // verified path above — turns any transient fs failure (EMFILE
                // under fd pressure, EACCES, EBUSY on Windows) into a stolen lock
                // and two concurrent writers on the same file.
                //
                // ENOENT is the exception and the common case: the lock was
                // released between our open() and our read, so there is nothing to
                // destroy and retrying immediately is correct.
                const code = (inspectError as NodeJS.ErrnoException | undefined)?.code;
                if (code === 'ENOENT') continue;
                logger.warn(
                  `[FileLockService] Could not inspect contended lock at ${this.lockFilePath} ` +
                  `(${code ?? 'unknown'}); backing off rather than reclaiming it.`,
                );
                metrics.increment('state_lock_inspect_failed_total', 1, { code: code ?? 'unknown' });
                // Fall through to the timeout check + backoff below.
              }

              const stalledFor = Date.now() - lastProgressAt;
              const waitedFor = Date.now() - startTime;
              if (stalledFor >= this.lockTimeout || waitedFor >= this.acquireCeilingMs) {
                metrics.observe('state_lock_acquire_duration_ms', waitedFor, { status: 'timeout' });
                metrics.increment('state_lock_acquire_total', 1, { status: 'timeout' });
                // Say which bound was hit. "Timeout after 20000ms" on a lock whose
                // holder was working the whole time sent readers looking for a
                // deadlock that was never there.
                throw new Error(
                  waitedFor >= this.acquireCeilingMs
                    ? `Failed to acquire lock at ${this.lockFilePath}: gave up after ${waitedFor}ms of contention (ceiling ${this.acquireCeilingMs}ms)`
                    : `Failed to acquire lock at ${this.lockFilePath}: timeout after ${this.lockTimeout}ms with no sign of progress from its holder`,
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
      this._releaseTurn();
      throw err;
    }
  }

  /**
   * Release the filesystem lock.
   */
  async releaseLock(): Promise<void> {
    if (this.lockHandle === null) {
      // cleanup() can tear the handle down underneath an in-flight critical
      // section, so withLock()'s finally lands here with the handle already gone.
      // The queue turn is still ours to hand back — returning without doing so
      // leaves every queued waiter blocked on `await previous` for good.
      this._releaseTurn();
      return;
    }

    this.lockCount--;
    if (this.lockCount > 0) {
      return;
    }

    // Fully releasing (not a re-entrant pop) — the mtime heartbeat must stop
    // with the hold it maintains.
    this._stopHeartbeat();

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

      metrics.setGauge('state_lock_held', 0, { lock: this.lockName });
    } finally {
      // 4. Signal the next caller in the queue that it's their turn.
      this._releaseTurn();
    }
  }

  /**
   * Execute a function within the scope of a filesystem lock.
   * This is the preferred way to use the lock service.
   * Safe re-entrancy is supported within the same async flow.
   *
   * The acquire timeout is the one given to the constructor (`lockTimeout`). This
   * used to take a second `_timeout` argument that was accepted and then ignored
   * entirely — a caller passing 5000 silently got the constructed 20000 — so it is
   * gone rather than left to mislead. No caller was passing it.
   */
  async withLock<T>(callback: () => Promise<T> | T): Promise<T> {
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
   * Clean up any lock file owned by this instance, and retire the instance.
   *
   * Called only from shutdown paths (`dispose`, `StateManager.cleanup`). It first
   * gives an in-flight critical section a bounded chance to release normally, then
   * forces the teardown if it has not. After this the instance is retired:
   * `acquireLock` fails fast rather than blocking on a queue nothing will ever
   * drain, which is what makes forcing the teardown safe to do at all.
   */
  async cleanup(): Promise<void> {
    const drained = await this._drainHeldLock(CLEANUP_DRAIN_TIMEOUT_MS);
    if (!drained) {
      logger.warn(
        `[FileLockService] Lock at ${this.lockFilePath} still held after ${CLEANUP_DRAIN_TIMEOUT_MS}ms; forcing teardown. ` +
        'A concurrent writer in another process may observe the lock as free.',
      );
      metrics.increment('state_lock_forced_teardown_total', 1);
    }

    // Retire BEFORE releasing the turn, so a waiter woken below re-checks and
    // fails fast instead of acquiring a lock this instance no longer manages.
    this._retired = true;
    // The forced-teardown path bypasses releaseLock, so stop the heartbeat here
    // too — a retired instance must not keep freshening a lock it forfeited.
    this._stopHeartbeat();

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
    // Unblock anyone parked on `await previous`; they will now see _retired and throw.
    this._releaseTurn();
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
