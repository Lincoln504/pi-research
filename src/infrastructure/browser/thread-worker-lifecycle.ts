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
    // Don't crash immediately unless it's critical, the worker will be replaced by poolifier if it hangs
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
