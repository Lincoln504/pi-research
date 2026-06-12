/**
 * Task Execution Service
 *
 * Handles task execution with retry logic and circuit breaker.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import type { Config } from '../../config.ts';
import type { SearchResult } from '../../web-research/types.ts';
import type { BrowserTask } from '../../types/index.ts';
import { logger } from '../../logger.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { getBrowserCircuitBreaker, browserCircuitBreaker, isTransientSocketError, isPoolShutdownError, isTaskTimeoutError, isCloudflareBlockError } from './browser-error-utils.ts';
import { getScheduler as _getScheduler, forceSchedulerRestart as _forceSchedulerRestart } from './scheduler-factory.ts';
import { waitForBrowserPoolIdle } from './browser-lifecycle.ts';
import { getServiceContainer, getService } from '../../core/service-registry.ts';
import type { ServiceContainer } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { ISchedulerFactory, IScheduler } from '../../core/scheduler-factory.ts';

// Cooldown to prevent cascading scheduler restarts (thundering herd)
let lastRestartTime = 0;
const RESTART_COOLDOWN_MS = 10000;

/**
 * Get the scheduler from the factory, optionally using a specific container.
 */
async function getScheduler(config?: Config, container: ServiceContainer = getServiceContainer()): Promise<IScheduler> {
    try {
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY, undefined, container);
        return await factory.getScheduler(config);
    } catch {
        // Fallback to factory function if service resolution fails (e.g. during early init or tests)
        return await _getScheduler(config, container);
    }
}

/**
 * Force a scheduler restart, optionally using a specific container.
 */
async function forceSchedulerRestart(forceClearRemoteState: boolean = false, container: ServiceContainer = getServiceContainer()): Promise<void> {
    try {
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY, undefined, container);
        return await factory.forceSchedulerRestart(forceClearRemoteState);
    } catch {
        return await _forceSchedulerRestart(forceClearRemoteState, container);
    }
}

/**
 * Dispatches a browser task to the unified worker pool.
 */
export async function runBrowserTask<T>(
    taskOrUrl: string | BrowserTask,
    type: 'search' | 'scrape' = 'scrape',
    config?: Config,
    signal?: AbortSignal,
    retries = 1,
    container: ServiceContainer = getServiceContainer()
): Promise<T> {
    if (signal?.aborted) throw new Error('Aborted');

    // Extract sessionId for circuit breaker scoping
    const sessionId = typeof taskOrUrl === 'object' ? taskOrUrl.sessionId : undefined;
    const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;

    try {
        return await breaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config, container);
            if (type === 'search') {
                const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).query;
                if (!query) throw new Error('Search task requires a query');
                return (await scheduler.runSearch(query, config, signal)) as T;
            }

            const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).url;
            if (url) {
                return (await scheduler.runScrape(url, config, signal)) as T;
            }

            throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
        });
    } catch (error: unknown) {
        if (signal?.aborted || (error instanceof Error && error.message === 'Aborted')) throw new Error('Aborted', { cause: error });

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: type,
                taskType: type,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during ${type} task (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
            
            if (isPoolShutdownError(error)) {
                // Pool is temporarily draining — wait for the drain to finish.
                logger.warn(`[BrowserManager] Pool is draining — waiting for pool idle before retry...`);
                await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
            } else {
                // True socket/connection error — restart the scheduler with thundering herd guard.
                const now = Date.now();
                if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
                    lastRestartTime = now;
                    logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                    await forceSchedulerRestart(true, container);
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                } else {
                    logger.warn(`[BrowserManager] Scheduler restart recently triggered, waiting for pool idle...`);
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                }
            }

            // Retry with jitter (100-500ms) to prevent thundering herd
            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runBrowserTask<T>(taskOrUrl, type, config, signal, retries - 1, container);
        }
        throw error;
    }
}

/**
 * Run a browser health check with retry logic.
 */
export async function runBrowserHealthCheck(config?: Config, retries = 1, signal?: AbortSignal, container: ServiceContainer = getServiceContainer()): Promise<{ success: boolean }> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config, container);
            return await scheduler.runHealthCheck(config, signal);
        });
    } catch (error: unknown) {
        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'healthcheck',
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during healthcheck (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
            
            if (isPoolShutdownError(error)) {
                await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
            } else {
                const now = Date.now();
                if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
                    lastRestartTime = now;
                    logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                    await forceSchedulerRestart(true, container);
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                } else {
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                }
            }

            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runBrowserHealthCheck(config, retries - 1, signal, container);
        }
        throw error;
    }
}

/**
 * Run a worker search query with retry logic.
 */
export async function runWorkerSearch(query: string, config?: Config, signal?: AbortSignal, retries = 1, sessionId?: string, container: ServiceContainer = getServiceContainer()): Promise<SearchResult[]> {
    if (signal?.aborted) throw new Error('Aborted');
    
    const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;

    try {
        return await breaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config, container);
            return await scheduler.runSearch(query, config, signal);
        });
    } catch (error: unknown) {
        if (signal?.aborted || (error instanceof Error && error.message === 'Aborted')) throw new Error('Aborted', { cause: error });

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'search',
                query,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during search (retries left: ${retries}): ${(error instanceof Error ? error.message : String(error)).substring(0, 100)}...`);
            
            if (isPoolShutdownError(error)) {
                await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
            } else {
                const now = Date.now();
                if (now - lastRestartTime > RESTART_COOLDOWN_MS) {
                    lastRestartTime = now;
                    logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                    await forceSchedulerRestart(true, container);
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                } else {
                    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
                }
            }

            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runWorkerSearch(query, config, signal, retries - 1, sessionId, container);
        }
        throw error;
    }
}
