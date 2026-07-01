/**
 * Thread Worker Lifecycle Management
 *
 * Handles worker lifecycle - orphaned worker protection, shutdown handling,
 * and worker process management.
 */

import process from 'node:process';
import cluster from 'node:cluster';
import * as fs from 'node:fs/promises';
import { redactSecrets } from '../../utils/log-utils.ts';

let workerId: string = '';

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Handle ERR_IPC_CHANNEL_CLOSED when poolifier tries to send messages during shutdown
 */
export function setupIpcErrorHandler(): void {
  if (!cluster.isWorker || !cluster.worker) {
    return;
  }
  cluster.worker.on('error', (err: any) => {
    if (err && err.code === 'ERR_IPC_CHANNEL_CLOSED') {
      return;
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Master-side counterpart to setupIpcErrorHandler()
// ---------------------------------------------------------------------------

/**
 * IPC error codes that are benign when a worker's channel is mid-teardown: the
 * write failed because the pipe is already gone. poolifier independently counts
 * worker errors and respawns, so swallowing these does not hide a real fault.
 */
const BENIGN_IPC_CODES = new Set(['EPIPE', 'ERR_IPC_CHANNEL_CLOSED', 'ECONNRESET']);

export function isBenignClusterIpcError(err: any): boolean {
  if (!err) return false;
  if (typeof err.code === 'string' && BENIGN_IPC_CODES.has(err.code)) return true;
  const msg = String(err.message || err);
  return /\b(EPIPE|ECONNRESET)\b/.test(msg) || /channel closed/i.test(msg);
}

let masterIpcGuardInstalled = false;

/**
 * Master-side guard against the unhandled `write EPIPE` that crashed the whole pi
 * host (observed twice on 2026-06-30 during a populate loop, each preceded by
 * knowledge-extraction 429s → worker churn).
 *
 * Mechanism: poolifier's FixedClusterPool dispatches tasks with cluster
 * `worker.send()`. When a worker's IPC channel closes (a 429-driven respawn, a
 * crash, or terminate()), an in-flight/subsequent send completes with `write
 * EPIPE`. Node's cluster module re-emits that as an 'error' on the cluster.Worker.
 * poolifier attaches its own 'error' listener — but during terminate() it calls
 * `worker.removeAllListeners()`, after which the cluster module's internal re-emit
 * (`worker.process.on('error', ...)`, which poolifier never strips) fires
 * `worker.emit('error', EPIPE)` on a Worker with NO listeners → EventEmitter
 * throws → uncaughtException → the pi host exits.
 *
 * The worker-side guard (setupIpcErrorHandler) returns early in the master, so the
 * master had no equivalent. This installs a PERSISTENT benign-IPC-error swallower
 * on every forked worker that survives poolifier's removeAllListeners(), so the
 * cluster.Worker is never without an 'error' listener at the moment cluster
 * re-emits. Idempotent; safe to call before each pool (re)creation.
 */
export function setupMasterIpcErrorHandler(): void {
  if (masterIpcGuardInstalled) return;
  // Workers use setupIpcErrorHandler(); this guard is for the primary process
  // that owns the cluster pool and originates the failing worker.send() calls.
  if (cluster.isWorker) return;
  masterIpcGuardInstalled = true;

  // cluster emits 'fork' for every worker poolifier creates, including the
  // respawns it triggers via startMinimumNumberOfWorkers() after an unexpected
  // exit — so this catches the churn-driven workers, not just the initial set.
  cluster.on('fork', (worker) => guardClusterWorker(worker));

  // Cover any workers already forked before this handler was installed.
  for (const id of Object.keys(cluster.workers ?? {})) {
    const w = (cluster.workers as any)?.[id];
    if (w) guardClusterWorker(w);
  }
}

/** Reset for tests — re-arms the one-time install guard. */
export function __resetMasterIpcGuardForTests(): void {
  masterIpcGuardInstalled = false;
}

function guardClusterWorker(worker: any): void {
  if (!worker || worker.__piIpcGuarded) return;
  worker.__piIpcGuarded = true;

  const guard = (err: any) => {
    if (isBenignClusterIpcError(err)) {
      logToDebugFile('DEBUG', `[Master] Swallowed benign worker IPC error: ${err?.code || err?.message}`);
      return;
    }
    // Non-benign worker errors are independently handled by poolifier's own
    // errorHandler (which counts them and triggers pool recovery). Re-throwing
    // here would itself become an uncaughtException, so just record it.
    logToDebugFile('WARN', `[Master] Worker error (non-IPC): ${err?.stack || err?.message || err}`);
  };

  worker.on('error', guard);
  if (worker.process && typeof worker.process.on === 'function') {
    // The channel-write EPIPE is emitted on the underlying ChildProcess; cluster
    // re-emits it to the Worker, but listen here too so a direct process 'error'
    // (no re-emit) is also handled.
    worker.process.on('error', guard);
  }

  // poolifier calls worker.removeAllListeners() during terminate(), stripping our
  // guard right before the channel's final write can EPIPE. Re-arm after any
  // removal so the cluster.Worker is never without an 'error' listener.
  if (typeof worker.removeAllListeners === 'function') {
    const originalRemoveAll = worker.removeAllListeners.bind(worker);
    worker.removeAllListeners = (event?: string | symbol) => {
      const ret = originalRemoveAll(event);
      if (event === undefined || event === 'error') {
        worker.on('error', guard);
      }
      return ret;
    };
  }
}

/**
 * Handle Uncaught Exceptions in Worker
 */
export function setupUncaughtExceptionHandler(): void {
  process.on('uncaughtException', (err: Error) => {
    // Suppress Playwright core errors that shouldn't crash the worker
    if (err && err.message && err.message.includes('reading \'url\'') && err.stack && err.stack.includes('coreBundle.js')) {
      logToDebugFile('WARN', `[Worker-${workerId}] Suppressed Playwright core error: ${err.message}`);
      return;
    }
    // Also suppress Playwright frame errors (reading 'frames')
    if (err && err.message && err.message.includes('reading \'frames\'') && err.stack && err.stack.includes('coreBundle.js')) {
      logToDebugFile('WARN', `[Worker-${workerId}] Suppressed Playwright frame error: ${err.message}`);
      return;
    }
    
    logToDebugFile('ERROR', `[Worker-${workerId}] Uncaught Exception: ${err.stack || err.message}`);
    // A non-suppressed uncaughtException leaves the worker's V8 state undefined
    // (Node's documented semantics). Continuing to serve scrape/search tasks from
    // here risks corrupt results, so exit and let poolifier respawn a clean worker.
    // The pool's exitHandler counts non-zero exits and auto-recovers after a few,
    // so a genuinely crash-looping worker is still handled — unlike a silently
    // broken one. The two Playwright-internal patterns above are returned before
    // this point precisely because they do NOT corrupt worker state.
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const errMsg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    // Log but do NOT exit — a stray Playwright background rejection (e.g. cancelled
    // navigation) would kill an otherwise healthy worker and cause pool churn.
    // Poolifier's own health-check will replace the worker if it becomes truly broken.
    //
    // Known-benign Playwright-internal rejection: dispatching a scraped page's own
    // uncaught JS error throws inside coreBundle.js when Firefox reports a `pageError`
    // with no `location` (`reading 'url'`) or a torn-down frame (`reading 'frames'`).
    // It originates in Playwright's dispatcher before any of our listeners, so it
    // cannot be prevented at the source — and it has zero effect on the scrape result.
    // Downgrade to DEBUG so it doesn't masquerade as an actionable WARN in the logs.
    const benignPlaywright = reason instanceof Error
      && /reading '(url|frames)'/.test(reason.message || '')
      && /coreBundle\.js/.test(reason.stack || '');
    logToDebugFile(
      benignPlaywright ? 'DEBUG' : 'WARN',
      `[Worker-${workerId}] Unhandled Rejection (non-fatal): ${errMsg}`,
    );
  });
}

// Orphaned worker protection: If parent dies, kill the worker.
// This works cross-platform (Linux, Mac, Windows) in Node.js.
let orphanCheckTimer: NodeJS.Timeout | null = null;
let cleanupBrowser: (() => Promise<void>) | null = null;

/**
 * Set the browser cleanup function to call on shutdown
 */
export function setBrowserCleanup(fn: () => Promise<void>): void {
  cleanupBrowser = fn;
}

/**
 * Set up orphaned worker protection - shuts down the worker if parent process dies
 */
export function setupOrphanProtection(): void {
  if (!cluster.isWorker) {
    return;
  }

  if (!process.ppid) {
    return;
  }

  const checkOrphan = async () => {
    try {
      // signal 0 checks if the process is alive
      process.kill(process.ppid, 0);

      // Schedule next check
      orphanCheckTimer = setTimeout(checkOrphan, 10000);
      if (orphanCheckTimer) {
        orphanCheckTimer.unref();
      }
    } catch (_e) {
      // EPERM means the parent is ALIVE but owned by another user (multi-user host
      // / CI) — NOT orphaned. Only ESRCH (no such process) is a real orphan. Don't
      // self-terminate a healthy worker (and tear down its live browser) on EPERM.
      if ((_e as NodeJS.ErrnoException)?.code === 'EPERM') {
        orphanCheckTimer = setTimeout(checkOrphan, 10000);
        orphanCheckTimer?.unref();
        return;
      }
      // If error is thrown, the parent process is likely dead or unreachable
      logToDebugFile('WARN', `[Worker-${workerId}] Parent process died or unreachable (orphaned), shutting down...`);
      // FIX: Await cleanup to prevent browser/context leaks
      if (cleanupBrowser) {
        await cleanupBrowser().catch(err => {
          logToDebugFile('WARN', `[Worker-${workerId}] Browser cleanup failed during orphan exit:`, err);
        });
      }
      // Clear the orphan check timer
      cleanupOrphanProtection();
      process.env['PI_PROCESS_EXITING'] = '1';
      process.exit(1);
    }
  };

  // Initial schedule
  orphanCheckTimer = setTimeout(checkOrphan, 10000);
  if (orphanCheckTimer) {
    orphanCheckTimer.unref();
  }
}

/**
 * Clean up orphan protection resources
 */
export function cleanupOrphanProtection(): void {
  if (orphanCheckTimer) {
    clearTimeout(orphanCheckTimer);
    orphanCheckTimer = null;
  }
}

/**
 * Log to debug file
 */
function logToDebugFile(level: string, ...args: any[]): void {
  const logFile = process.env['PI_RESEARCH_LOG_FILE'];
  if (!logFile) return;
  // Match the main-process logger: WARN/ERROR are always recorded (crash diagnostics);
  // INFO/DEBUG only when verbose. Without this gate a non-verbose scaling run still
  // streamed thousands of worker DEBUG lines to PI_RESEARCH_LOG_FILE — often a tmpfs
  // (RAM) path — adding memory and I/O pressure for no benefit during sustained loops.
  if ((level === 'INFO' || level === 'DEBUG') && process.env['PI_RESEARCH_DEBUG'] !== 'true') return;

  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      message: redactSecrets(args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' '))
    };
    // FIX (#32): Use async fs.appendFile to avoid blocking the event loop.
    // Fire-and-forget is acceptable for debug logging in error handlers.
    fs.appendFile(logFile, `${JSON.stringify(entry)}\n`).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Create a kill handler for poolifier worker shutdown
 */
export function createKillHandler(): () => Promise<void> {
  return async () => {
    logToDebugFile('INFO', `[Worker-${workerId}] Worker shutting down`);
    if (cleanupBrowser) {
      await cleanupBrowser().catch(err => {
        logToDebugFile('WARN', `[Worker-${workerId}] Browser cleanup failed during shutdown:`, err);
      });
    }
    // Clear the orphan check timer to prevent it from keeping the event loop alive
    cleanupOrphanProtection();

    if (!cluster.isWorker) {
      // Primary process — killHandler should not exit the orchestrator.
      return;
    }

    // Force process exit for cluster workers — without this, the orphan-detection setInterval keeps
    // the event loop alive indefinitely after the IPC channel is disconnected.
    setTimeout(() => {
      logToDebugFile('INFO', `[Worker-${workerId}] Forcing process exit (Cluster)`);
      process.env['PI_PROCESS_EXITING'] = '1';
      process.exit(0);
    }, 100).unref();
  };
}
