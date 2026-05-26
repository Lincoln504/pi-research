/**
 * Browser Infrastructure - Public API
 *
 * This module exports all browser-related functionality.
 */

// Configuration utilities
export {
    generateSchedulerVersion,
    getMaxWorkers,
    getSchedulerVersion,
    isBrowserAvailable,
} from './browser-configuration.ts';

// Client agent
export {
    getClientAgent,
    clientAgent,
} from './client-agent.ts';

// Error utilities
export {
    isTransientSocketError,
    isPoolShutdownError,
    browserCircuitBreaker,
    resetBrowserCircuitBreaker,
} from './browser-error-utils.ts';

// Scheduler types
export type { IScheduler } from './browser-client.ts';

// Scheduler factory
export {
    getScheduler as _internalGetScheduler,
    forceSchedulerRestart,
} from './scheduler-factory.ts';

// Task execution service
export {
    runBrowserTask,
    runBrowserHealthCheck,
    runWorkerSearch,
} from './task-execution-service.ts';

// Lifecycle management
export {
    stopBrowserManager,
    waitForBrowserPoolIdle,
} from './browser-lifecycle.ts';
