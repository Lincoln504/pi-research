/**
 * Browser Manager - Re-exports for backward compatibility
 *
 * This module re-exports functionality from the refactored browser infrastructure
 * to maintain backward compatibility with existing code and tests.
 *
 * The browser functionality has been refactored into:
 * - SchedulerService (src/core/scheduler-service.ts)
 * - Browser infrastructure (src/infrastructure/browser/)
 */

// Re-export from scheduler-service
export { stopBrowserManager } from './browser-cleanup.ts';

// Re-export from browser infrastructure
export {
  isBrowserAvailable,
  getMaxWorkers,
  getSchedulerVersion,
} from './browser/browser-configuration.ts';

export {
  runBrowserTask,
  runBrowserHealthCheck,
  runWorkerSearch,
} from './browser/task-execution-service.ts';

export {
  forceSchedulerRestart,
} from './browser/scheduler-factory.ts';