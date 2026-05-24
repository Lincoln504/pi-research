/**
 * Browser Infrastructure - Public API
 *
 * This module exports all browser-related functionality.
 * Provides backward compatibility with the original browser-manager API.
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
    browserCircuitBreaker,
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

// For backward compatibility, also export with the old names
export { generateSchedulerVersion as _internalGenerateSchedulerVersion } from './browser-configuration.ts';
export { getSchedulerVersion as _internalGetSchedulerVersion } from './browser-configuration.ts';