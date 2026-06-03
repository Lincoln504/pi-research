/**
 * Thread Worker Lifecycle Management
 *
 * Handles worker lifecycle - orphaned worker protection, shutdown handling,
 * and worker process management.
 */

import process from 'node:process';
import cluster from 'node:cluster';
import { isMainThread } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';

let workerId: string = '';

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Get the worker ID
 */
export function getWorkerId(): string {
  return workerId;
}

/**
 * Handle ERR_IPC_CHANNEL_CLOSED when poolifier tries to send messages during shutdown
 */
export function setupIpcErrorHandler(): void {
  if (!isMainThread) {
    // In worker threads, errors are bubbled up to the parentPort
    return;
  }
  if (cluster.isWorker && cluster.worker) {
    cluster.worker.on('error', (err: any) => {
      if (err && err.code === 'ERR_IPC_CHANNEL_CLOSED') {
        return;
      }
      throw err;
    });
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
    // Don't crash immediately unless it's critical, the worker will be replaced by poolifier if it hangs
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
  // Orphan protection is primarily for separate processes (cluster).
  // Threads die when the main process dies.
  if (!isMainThread) {
    return;
  }

  if (!process.ppid) {
    return;
  }

  orphanCheckTimer = setInterval(async () => {
    try {
      // signal 0 checks if the process is alive
      process.kill(process.ppid, 0);
    } catch (_e) {
      // If error is thrown, the parent process is likely dead or unreachable
      logToDebugFile('WARN', `[Worker-${workerId}] Parent process died or unreachable (orphaned), shutting down...`);
      // FIX: Await cleanup to prevent browser/context leaks
      if (cleanupBrowser) {
        await cleanupBrowser().catch(err => {
          logToDebugFile('WARN', `[Worker-${workerId}] Browser cleanup failed during orphan exit:`, err);
        });
      }
      // Clear the orphan check timer to prevent it from keeping the event loop alive
      if (orphanCheckTimer) {
        clearInterval(orphanCheckTimer);
        orphanCheckTimer = null;
      }
      process.exit(1);
    }
  }, 10000);

  if (orphanCheckTimer) {
    orphanCheckTimer.unref();
  }
}

/**
 * Clean up orphan protection resources
 */
export function cleanupOrphanProtection(): void {
  if (orphanCheckTimer) {
    clearInterval(orphanCheckTimer);
    orphanCheckTimer = null;
  }
}

/**
 * Log to debug file
 */
function logToDebugFile(level: string, ...args: any[]): void {
  const logFile = process.env['PI_RESEARCH_LOG_FILE'];
  if (!logFile) return;

  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      message: args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' ')
    };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
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

    // In worker threads, we don't want to call process.exit() as it terminates the whole process.
    // We only call it in cluster workers (processes).
    if (isMainThread && !cluster.isWorker) {
      // This is the primary process, do not exit.
      return;
    }

    if (cluster.isWorker) {
      // Force process exit for cluster workers — without this, the orphan-detection setInterval keeps
      // the event loop alive indefinitely after the IPC channel is disconnected.
      setTimeout(() => {
        logToDebugFile('INFO', `[Worker-${workerId}] Forcing process exit (Cluster)`);
        process.exit(0);
      }, 100).unref();
    }
  };
}
