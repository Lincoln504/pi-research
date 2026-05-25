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
import { SchedulerService } from '../../core/scheduler-service.ts';
import { BrowserTaskScheduler } from './browser-task-scheduler.ts';

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
    const schedulerService = tryGetService<SchedulerService>(ServiceNames.SCHEDULER);
    
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
