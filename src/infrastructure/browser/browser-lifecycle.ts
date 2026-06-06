/**
 * Browser Lifecycle
 *
 * Top-level lifecycle helpers that tie together the scheduler, worker pool,
 * and state-manager. Used by SchedulerService.dispose() to tear down the
 * browser subsystem cleanly.
 */

import { logger } from '../../logger.ts';
import { tryGetService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { ISchedulerInternals } from '../../core/interfaces/scheduler-interfaces.ts';
import { BrowserTaskScheduler } from './browser-task-scheduler.ts';
import type { WorkerPoolManager } from './worker-pool-manager.ts';


/**
 * Stop the current browser manager / scheduler instance.
 *
 * Retrieves the cached scheduler from SchedulerService, calls shutdown() if
 * it is a BrowserTaskScheduler, then clears all cached references so the next
 * request starts fresh.
 */
export async function stopBrowserManager(): Promise<void> {
  try {
    // Try to get the service synchronously first to avoid errors if not initialized
    const schedulerService = tryGetService<ISchedulerInternals>(ServiceNames.SCHEDULER);
    
    if (!schedulerService) {
      logger.debug('[BrowserLifecycle] Scheduler service not available, nothing to stop');
      return;
    }
    
    const instance = schedulerService.getSchedulerInstance();

    if (instance instanceof BrowserTaskScheduler) {
      await instance.shutdown();
    } else if (instance && typeof (instance as any).shutdown === 'function') {
      await (instance as any).shutdown();
    }

    // Clear all cached scheduler references
    schedulerService.setSchedulerInstance(null);
    schedulerService.setSchedulerVersion(null);
    schedulerService.setSchedulerInitializationPromise(null);

    logger.debug('[BrowserLifecycle] Browser manager stopped and references cleared');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[BrowserLifecycle] Error stopping browser manager:', msg);
  }
}

/**
 * Wait until any background scheduler shutdown (from a fire-and-forget
 * forceSchedulerRestart) has fully completed, including the WorkerPoolManager's
 * 1500ms IPC drain. Safe to call when no shutdown is in progress — resolves
 * immediately.
 *
 * Strategy:
 * 1. Await the pending shutdown promise stored in SchedulerService (set by
 *    forceSchedulerRestart when it fires-and-forgets oldScheduler.shutdown()).
 *    This is the authoritative signal that the full chain — including the
 *    WorkerPoolManager drain — has completed.
 * 2. Fall back to polling WorkerPoolManager.isPoolShuttingDown() for any
 *    shutdown that was initiated outside of forceSchedulerRestart (e.g.,
 *    stopBrowserManager called directly on a BrowserTaskScheduler).
 *
 * Used primarily in integration tests to bridge the gap between a
 * forceSchedulerRestart() call and subsequent browser task operations.
 */
export async function waitForBrowserPoolIdle(maxWaitMs = 15000): Promise<void> {
  const start = Date.now();

  // Phase 1: await the tracked fire-and-forget shutdown promise.
  // This covers the common case where forceSchedulerRestart was called: the promise
  // resolves only after BrowserTaskScheduler.shutdown() — including the WorkerPoolManager
  // drain — completes.
  //
  // Caveat: the retry path in task-execution-service may call forceSchedulerRestart again
  // on the failed (Scheduler2) instance, which replaces pendingShutdownPromise with a
  // quickly-resolving no-op promise (WorkerPoolManager.shutdown() is already running and
  // returns immediately on the second call). To guard against this, we always fall through
  // to Phase 2 and poll isPoolShuttingDown() after the promise resolves.
  const schedulerService = tryGetService<ISchedulerInternals>(ServiceNames.SCHEDULER);
  const pendingShutdown = schedulerService?.getPendingShutdownPromise();
  if (pendingShutdown) {
    const remainingMs = maxWaitMs - (Date.now() - start);
    if (remainingMs > 0) {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timeoutId = setTimeout(() => resolve('timeout'), remainingMs);
      });
      const pendingPromise = pendingShutdown.then(() => 'done' as const);
      pendingPromise.catch((err: any) => logger.debug(`[BrowserLifecycle] Background pending shutdown rejection: ${err instanceof Error ? err.message : String(err)}`));
      const winner = await Promise.race([
        pendingPromise,
        timeoutPromise,
      ]);
      if (timeoutId) clearTimeout(timeoutId);
      if (winner === 'timeout') {
        logger.warn('[BrowserLifecycle] waitForBrowserPoolIdle: timed out awaiting pendingShutdown after', maxWaitMs, 'ms');
        return;
      }
    }
    // Falls through to Phase 2 — the pending promise may have been a no-op shutdown
    // that resolved before the original drain finished.
  }

  // Phase 2: poll WorkerPoolManager.isPoolShuttingDown() until idle or timeout.
  const poolManager = tryGetService<WorkerPoolManager>(ServiceNames.WORKER_POOL_MANAGER);
  if (!poolManager || !poolManager.isPoolShuttingDown()) return;

  const deadline = Date.now() + (maxWaitMs - (Date.now() - start));
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!poolManager.isPoolShuttingDown()) return;
  }
  logger.warn('[BrowserLifecycle] waitForBrowserPoolIdle: pool still shutting down after', maxWaitMs, 'ms');
}
