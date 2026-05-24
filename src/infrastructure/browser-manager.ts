/**
 * Browser Manager - Refactored Facade
 *
 * This file now acts as a facade over the decomposed browser infrastructure.
 * All functionality has been extracted into focused services for better separation of concerns.
 *
 * NEW ARCHITECTURE:
 * - browser-configuration.ts: Configuration utilities
 * - client-agent.ts: HTTP client agent
 * - browser-error-utils.ts: Error detection and circuit breaker
 * - browser-client.ts: HTTP client for remote scheduler
 * - worker-pool-manager.ts: Worker pool lifecycle management
 * - browser-task-scheduler.ts: Browser task scheduler (leader mode)
 * - scheduler-factory.ts: Scheduler creation and lifecycle
 * - task-execution-service.ts: Task execution with retry logic
 *
 * This file maintains backward compatibility by delegating to the new services.
 */

import type { IScheduler } from './browser/browser-client.ts';

// ============================================================================
// Re-export everything for backward compatibility
// ============================================================================

// Configuration utilities
export {
    generateSchedulerVersion,
    getMaxWorkers,
    getSchedulerVersion,
    isBrowserAvailable,
} from './browser/browser-configuration.ts';

// Client agent
export {
    getClientAgent,
    clientAgent,
} from './browser/client-agent.ts';

// Error utilities
export {
    isTransientSocketError,
    browserCircuitBreaker,
} from './browser/browser-error-utils.ts';

// Scheduler factory
export {
    getScheduler as _internalGetScheduler,
    forceSchedulerRestart,
} from './browser/scheduler-factory.ts';

// Task execution service
export {
    runBrowserTask,
    runBrowserHealthCheck,
    runWorkerSearch,
} from './browser/task-execution-service.ts';

// For backward compatibility, also export with the old names
export { generateSchedulerVersion as _internalGenerateSchedulerVersion } from './browser/browser-configuration.ts';
export { getSchedulerVersion as _internalGetSchedulerVersion } from './browser/browser-configuration.ts';

// ============================================================================
// Stop browser manager - shutdown all resources
// ============================================================================

import { browserCircuitBreaker as circuitBreaker } from './browser/browser-error-utils.ts';
import { getClientAgent as getAgent } from './browser/client-agent.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { SchedulerService } from '../core/scheduler-service.ts';
import { metrics } from '../utils/metrics.ts';

/**
 * Stop the browser manager and clean up all resources.
 */
export async function stopBrowserManager(): Promise<void> {
    circuitBreaker.reset();
    metrics.increment('browser_manager_shutdowns_total', 1);
    const schedulerService = await getService<SchedulerService>(ServiceNames.SCHEDULER);
    const globalScheduler = schedulerService.getSchedulerInstance();

    // Clear both references before any async work so concurrent getScheduler()
    // calls during shutdown see null and start fresh rather than receiving a
    // scheduler that is mid-teardown.
    schedulerService.setSchedulerInstance(null);
    schedulerService.setSchedulerInitializationPromise(null);

    // Import the BrowserTaskScheduler class to check instance type
    const { BrowserTaskScheduler } = await import('./browser/browser-task-scheduler.ts');

    if (globalScheduler && globalScheduler instanceof BrowserTaskScheduler) {
        // Do not call clearBrowserServer() here — BrowserTaskScheduler.shutdown() already
        // does it with the proper pid+schedulerId dual-check to avoid wiping state owned
        // by a newer scheduler that won election in the same process.
        await globalScheduler.shutdown();
    }

    // Destroy the keep-alive HTTP agent so its open sockets don't block process exit.
    const agent = getAgent();
    agent.destroy();
}

// ============================================================================
// Internal scheduler interface (for type compatibility)
// ============================================================================

/**
 * Internal scheduler interface for type compatibility.
 * This is used by other modules that need to access the scheduler directly.
 */
export interface ISchedulerInternal extends IScheduler {
    schedulerId?: string;
    shutdown(): Promise<void>;
    resetIdleTimerOnActivity?(): void;
}

// ============================================================================
// Export internal types for testing
// ============================================================================

export type { IScheduler } from './browser/browser-client.ts';
export type { BrowserTaskScheduler } from './browser/browser-task-scheduler.ts';
export type { BrowserClient } from './browser/browser-client.ts';
export type { WorkerPoolManager } from './browser/worker-pool-manager.ts';