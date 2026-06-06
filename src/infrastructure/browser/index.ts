/**
 * Browser Infrastructure - Public API
 *
 * Barrel module for browser-related functionality. Source code imports
 * directly from specific submodules; this file exists for test convenience.
 */

export {
    getMaxWorkers,
    getSchedulerVersion,
    isBrowserAvailable,
    getCamoufoxBinaryPath,
    getBrowserCacheDir,
} from './config.ts';

export {
    isTransientSocketError,
    isPoolShutdownError,
    resetBrowserCircuitBreaker,
} from './browser-error-utils.ts';

export type { IScheduler } from '../../core/interfaces/scheduler-interfaces.ts';

export {
    forceSchedulerRestart,
} from './scheduler-factory.ts';

export {
    runBrowserTask,
    runBrowserHealthCheck,
    runWorkerSearch,
} from './task-execution-service.ts';

export {
    stopBrowserManager,
    waitForBrowserPoolIdle,
} from './browser-lifecycle.ts';
