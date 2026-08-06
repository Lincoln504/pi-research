/**
 * Research Run Semaphore
 *
 * Cross-process cap on the number of concurrent research runs, built on the
 * verified {@link FileLockService}. This is the Phase 1 "run-cap" mitigation for
 * the parallel-runs degradation documented in
 * INVESTIGATION-2026-08-02-parallel-runs-sigabrt.md: when more than N research
 * runs pile onto a single leader-elected browser/embedding pool, the shared
 * priority queue saturates, runs churn through leader elections, and research
 * degrades into ~60-error failures. Capping concurrency at the orchestration
 * entry stops that at the source.
 *
 * ## Design
 *
 * A counting semaphore of N slots is realized as N well-known slot files
 * (`research-run-slot-<i>.lock`) in the shared state directory, coordinated with
 * {@link FileLockService}.
 *
 * - **Acquire** tries each slot once (round-robin from a rotating start index to
 *   spread contention). Each per-slot attempt builds a **fresh** `FileLockService`
 *   configured as a *try-take* (`lockTimeout: 0`): it either wins the slot (free,
 *   or reclaimed from a *dead* owner) immediately or throws as soon as it sees a
 *   *live* owner. If every slot is held by a live process, the loop waits
 *   `pollDelayMs` and retries until `maxWaitMs` elapses (by default
 *   {@link DEFAULT_ACQUIRE_TIMEOUT_MS} — extra runs **queue** behind the in-flight
 *   ones instead of failing), then rejects with {@link ResearchRunCapacityError}
 *   rather than degrading into a 60-error run.
 * - **Release** unlinks the slot file via the captured slot service.
 * - **Crash recovery** is automatic and PID-reuse-safe: a slot held by a process
 *   that has died (killed, crashed, SIGKILLed by earlyoom) is reclaimed
 *   immediately on the next acquire attempt, because `FileLockService` checks the
 *   owner's PID+startTime liveness before treating a lock as stale.
 *
 * ### Why a *fresh* FileLockService per attempt
 * `FileLockService.acquireLock()` serializes callers on a per-instance FIFO queue
 * and only releases that queue turn in `releaseLock()` — i.e. after the run ends.
 * Reusing a persistent per-slot instance would therefore **deadlock concurrent
 * research starts within one process**: the first holder keeps slot[i]'s queue
 * turn for minutes, blocking a second acquire on that slot forever (it would
 * never reach the other slots). A throwaway instance per attempt has an empty
 * queue, so concurrent attempts never block on stale queue state — while still
 * reusing all of FileLockService's verified atomic-create / liveness / reclaim
 * logic. Two concurrent attempts on the *same* slot simply race on `fs.open(wx)`:
 * one wins, the other reads a live owner and fails fast to the next slot.
 *
 * ### Why `liveOwnerStaleThreshold` is effectively infinite
 * A research run legitimately holds its slot for *minutes*. `FileLockService`
 * would normally steal a lock from a *live* owner once it ages past
 * `liveOwnerStaleThreshold` (to recover a process stalled mid-critical-section).
 * For a run-cap that is exactly wrong: stealing a live run's slot would silently
 * admit an (N+1)th concurrent run — reintroducing the saturation this guard
 * exists to prevent. So slots are configured to *never* steal from a live owner;
 * only provably-dead owners are reclaimed (immediately, regardless of age).
 *
 * ### Concurrency within one process
 * `acquire()` returns an independent {@link RunSlotAcquisition} handle capturing
 * its own slot service; it stores *no* shared "held slot" state. Two concurrent
 * `runResearch` calls on the same singleton service each acquire a distinct slot
 * safely (see "fresh instance per attempt" above), with no risk of one release
 * clobbering the other's tracking.
 */

import * as pathmod from 'node:path';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { FileLockService } from './file-lock-service.ts';
import { ServiceLifecycle } from '../core/service-registry.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { IService } from '../core/service-registry.ts';
import type { IProcessLifecycle } from '../core/interfaces/process-interfaces.ts';

/** Default maximum number of concurrent research runs across all processes. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;
/**
 * Default per-acquire wait before giving up when all slots are held by live runs.
 *
 * This is deliberately a *queue*, not a fail-fast. The cap exists to stop N runs
 * saturating the shared browser/embedding pool — but an extra run is a legitimate
 * request to do work, not an error, so the correct response to contention is to
 * serialize it behind the in-flight runs rather than to fail it. With a depth-1 run
 * measured at ~2-3 minutes, 10 minutes absorbs a backlog of roughly three further
 * runs per slot while still resolving well inside the agent-skill's documented
 * command timeouts (so a queued run never looks like a hang to the caller).
 *
 * Set `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS=0` to restore strict fail-fast.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 600_000;
/** Poll interval between full slot sweeps while waiting for a slot. */
const POLL_DELAY_MS = 250;

/**
 * Thrown when every run slot is held by a live process and the acquire timeout
 * has elapsed. Distinct from internal/IO errors so callers can treat
 * "capacity exhausted" (retry later) differently from "the semaphore is broken".
 */
export class ResearchRunCapacityError extends Error {
  readonly slots: number;
  constructor(slots: number, maxWaitMs: number) {
    super(
      `Maximum concurrent research runs (${slots}) reached${maxWaitMs > 0 ? ` and still busy after queueing for ${Math.round(maxWaitMs / 1000)}s` : ''}; ` +
        `another run is still in progress. This is temporary — retry shortly. ` +
        `(Raise the cap with PI_RESEARCH_MAX_CONCURRENT_RUNS, or the queue wait with ` +
        `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS.)`,
    );
    this.name = 'ResearchRunCapacityError';
    this.slots = slots;
  }
}

/** A held run slot. Call {@link RunSlotAcquisition.release} exactly once when the run ends. */
export interface RunSlotAcquisition {
  /** The 0-based slot index that was acquired (observability). */
  readonly slotIndex: number;
  /** Release the slot back to the pool. Safe to call once; subsequent calls are no-ops. */
  release(): Promise<void>;
}

/**
 * Counting semaphore over N slot files coordinated with {@link FileLockService}.
 */
export class ResearchRunSemaphore implements IService {
  readonly name = ServiceNames.RESEARCH_RUN_SEMAPHORE;
  lifecycle = ServiceLifecycle.UNINITIALIZED;

  private readonly slotDir: string;
  private readonly processLifecycle: IProcessLifecycle | null;
  private readonly maxSlots: number;
  private readonly defaultMaxWaitMs: number;
  /** Rotating start index so contending processes don't all hammer slot 0 first. */
  private nextStartIndex = 0;
  private _initialized = false;

  /**
   * @param slotDir    Directory holding the `research-run-slot-<i>.lock` files.
   * @param processLifecycle PID+startTime liveness source (PID-reuse-safe reclamation).
   * @param maxSlots   N — maximum concurrent runs. Defaults from env then {@link DEFAULT_MAX_CONCURRENT_RUNS}.
   * @param defaultMaxWaitMs Default acquire wait. Defaults from env then {@link DEFAULT_ACQUIRE_TIMEOUT_MS}.
   */
  constructor(slotDir: string, processLifecycle: IProcessLifecycle | null, maxSlots?: number, defaultMaxWaitMs?: number) {
    this.slotDir = slotDir;
    this.processLifecycle = processLifecycle;
    this.maxSlots = Math.max(1, Math.floor(
      maxSlots ?? numberFromEnv('PI_RESEARCH_MAX_CONCURRENT_RUNS') ?? DEFAULT_MAX_CONCURRENT_RUNS,
    ));
    this.defaultMaxWaitMs = Math.max(0, Math.floor(
      defaultMaxWaitMs ?? numberFromEnv('PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS') ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    ));
  }

  /** Number of slots (max concurrent runs). */
  getMaxSlots(): number {
    return this.maxSlots;
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;
    this.lifecycle = ServiceLifecycle.INITIALIZING;
    // Ensure the slot directory exists; slot files are created lazily on acquire.
    try {
      await import('node:fs/promises').then((fs) => fs.mkdir(this.slotDir, { recursive: true, mode: 0o700 }));
    } catch (err) {
      logger.warn(`[ResearchRunSemaphore] Could not create slot dir ${this.slotDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this._initialized = true;
    this.lifecycle = ServiceLifecycle.INITIALIZED;
    logger.log(`[ResearchRunSemaphore] Initialized with ${this.maxSlots} run slot(s) (acquire timeout ${this.defaultMaxWaitMs}ms).`);
  }

  async dispose(): Promise<void> {
    // Held slots are released by their RunSlotAcquisition handles (the runResearch
    // finally block). A hard process exit leaves slot files behind, which the next
    // acquire reclaims via PID+startTime liveness — so dispose has nothing to do.
    this.lifecycle = ServiceLifecycle.DISPOSED;
  }

  /**
   * Try to win one slot NON-BLOCKING. Builds a fresh {@link FileLockService}
   * configured as a try-take (see class doc: "fresh instance per attempt").
   * Returns an acquisition on success, or null if the slot is busy / lost a race.
   */
  private async trySlot(slotIndex: number): Promise<RunSlotAcquisition | null> {
    const slot = new FileLockService({
      lockFilePath: pathmod.join(this.slotDir, `research-run-slot-${slotIndex}.lock`),
      lockTimeout: 0, // fail immediately on a live-contended slot (try-take)
      lockRetries: 24, // enough iterations to complete a dead-owner reclaim + reacquire
      lockRetryDelay: 50,
      lockStaleThreshold: 15000, // legacy (no-pid) locks: reclaim once 15s old
      // A live process holding a run slot for the entire (minutes-long) run is the
      // NORMAL case, not a stall. Never steal from a live owner — doing so would
      // admit an (N+1)th concurrent run, the exact condition this guard prevents.
      // Dead owners are reclaimed immediately regardless of age.
      liveOwnerStaleThreshold: Number.MAX_SAFE_INTEGER,
      processLifecycle: this.processLifecycle ?? undefined,
    });
    try {
      await slot.initialize(); // resolves own startTime (cached) + startup stale cleanup
      await slot.acquireLock(); // try-take: wins, reclaims a dead owner, or throws fast
    } catch (err) {
      // Contention and breakage are different outcomes and must not be conflated.
      // FileLockService synthesizes its own Errors (no errno code) for the two
      // contention shapes a try-take produces — a live-contended slot ("timeout
      // after 0ms", cause EEXIST) and a lost reclaim race ("after N retries") —
      // and those genuinely mean "slot busy". A real I/O failure (ENOENT/EACCES/
      // ENOSPC: the slot file is uncreatable; both mkdirs are warn-only) instead
      // propagates the raw errno error. Swallowing that as "busy" would poll out
      // the whole acquire window and reject with a FALSE ResearchRunCapacityError,
      // making the documented fail-open contract (research proceeds when the
      // semaphore is broken) unreachable. Rethrow so acquire() can tell them apart.
      if (typeof (err as NodeJS.ErrnoException | null)?.code === 'string') throw err;
      return null; // busy (live owner) or lost a reclaim race — try the next slot
    }
    return {
      slotIndex,
      release: async () => {
        try {
          await slot.releaseLock();
        } catch (err) {
          logger.warn(`[ResearchRunSemaphore] Failed to release slot ${slotIndex}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          // Clear the gauge even if the unlink failed: the slot is no longer held
          // by THIS process either way, and a gauge that only ever ratchets to 1
          // reports permanent saturation for the life of the process.
          metrics.setGauge('research_run_slots_held', 0, { slot: String(slotIndex) });
        }
      },
    };
  }

  /**
   * Acquire one run slot, waiting up to `maxWaitMs` (defaults to the constructed
   * value) when all slots are held by live processes. Resolves with a handle that
   * must be released when the run ends.
   *
   * @param signal aborts the wait. Without it a run started under a long
   *   `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` would ignore Ctrl-C until the deadline
   *   passed, because the wait happens before any orchestrator exists to cancel.
   * @param onQueued invoked at most once, when the first full sweep finds every
   *   slot busy and the call is about to wait. Lets a front-end tell the user the
   *   run is queued rather than hung. Never allowed to break the acquire.
   * @throws {ResearchRunCapacityError} if no slot frees within `maxWaitMs`.
   * @throws {Error} named `AbortError` if `signal` aborts while waiting.
   */
  async acquire(
    maxWaitMs: number = this.defaultMaxWaitMs,
    signal?: AbortSignal,
    onQueued?: (slots: number, maxWaitMs: number) => void,
  ): Promise<RunSlotAcquisition> {
    if (!this._initialized) await this.initialize();
    if (signal?.aborted) {
      metrics.increment('research_run_acquire_total', 1, { status: 'aborted' });
      throwIfAborted(signal);
    }

    const deadline = Date.now() + Math.max(0, maxWaitMs);
    let announcedQueued = false;
    for (;;) {
      // Round-robin from a rotating start so contending processes don't synchronize on slot 0.
      const start = this.nextStartIndex;
      this.nextStartIndex = (this.nextStartIndex + 1) % this.maxSlots;
      // Slot BREAKAGE (I/O error) is tracked separately from contention within
      // this sweep — a broken slot must never be reported as a busy one.
      let brokenSlots = 0;
      let firstBreakage: unknown = null;
      for (let offset = 0; offset < this.maxSlots; offset++) {
        const i = (start + offset) % this.maxSlots;
        let got: RunSlotAcquisition | null;
        try {
          got = await this.trySlot(i);
        } catch (err) {
          // This slot is broken, not busy. Keep sweeping — another slot may still
          // be acquirable (mixed case: slot 0 uncreatable, slot 1 free).
          brokenSlots++;
          firstBreakage ??= err;
          logger.debug(`[ResearchRunSemaphore] Slot ${i} errored (broken, not busy): ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (got) {
          metrics.setGauge('research_run_slots_held', 1, { slot: String(i) });
          metrics.increment('research_run_acquire_total', 1, { status: 'acquired' });
          return got;
        }
      }
      // EVERY slot errored: the semaphore itself is broken, not at capacity.
      // Waiting cannot help — nothing is held that could free up — and a
      // ResearchRunCapacityError here would misclassify breakage as retryable
      // contention while the caller's fail-open path (research proceeds without
      // the cap) stays unreachable. Rethrow the I/O error instead.
      if (brokenSlots === this.maxSlots) {
        metrics.increment('research_run_acquire_total', 1, { status: 'error' });
        throw firstBreakage;
      }
      // Every remaining slot is held by a live process.
      if (Date.now() >= deadline) {
        metrics.increment('research_run_acquire_total', 1, { status: 'exhausted' });
        throw new ResearchRunCapacityError(this.maxSlots, maxWaitMs);
      }
      // Announce the queue exactly once, on the first sweep that found nothing free.
      // A throwing front-end callback must never fail the acquire.
      if (!announcedQueued) {
        announcedQueued = true;
        logger.info(`[ResearchRunSemaphore] All ${this.maxSlots} run slot(s) busy — queueing for up to ${maxWaitMs}ms.`);
        try {
          onQueued?.(this.maxSlots, maxWaitMs);
        } catch (err) {
          logger.debug(`[ResearchRunSemaphore] onQueued callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Count the aborted outcome too, so acquired + exhausted + aborted accounts for
      // every acquire attempt. A cancel that vanished from the counter would make the
      // capacity metrics quietly under-report demand.
      try {
        await sleep(POLL_DELAY_MS, signal);
      } catch (err) {
        metrics.increment('research_run_acquire_total', 1, { status: 'aborted' });
        throw err;
      }
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('Research run slot acquisition aborted'), { name: 'AbortError' });
  }
}

function numberFromEnv(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Poll delay that resolves early (rejecting) on abort.
 *
 * The timer is deliberately NOT `unref`'d. Waiting for a run slot is foreground work: a process
 * whose only pending handle is this timer must stay alive until the slot frees, and an unref'd
 * timer would let Node drain the loop and exit mid-wait (observed as an early exit in the
 * multi-process harness). The timer is always settled — it either fires or is cleared on abort —
 * so keeping it referenced cannot outlive the acquire.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = signal
      ? () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('Research run slot acquisition aborted'), { name: 'AbortError' }));
        }
      : undefined;
    if (onAbort) signal?.addEventListener('abort', onAbort, { once: true });
  });
}
