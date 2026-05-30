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
import { browserCircuitBreaker, isTransientSocketError, isPoolShutdownError, isTaskTimeoutError, isCloudflareBlockError } from './browser-error-utils.ts';
import { getScheduler, forceSchedulerRestart } from './scheduler-factory.ts';
import { waitForBrowserPoolIdle } from './browser-lifecycle.ts';

/**
 * Dispatches a browser task to the unified worker pool.
 */
export async function runBrowserTask<T>(
    taskOrUrl: string | BrowserTask,
    type: 'search' | 'scrape' = 'scrape',
    config?: Config,
    signal?: AbortSignal,
    retries = 1
): Promise<T> {
    if (signal?.aborted) throw new Error('Aborted');

    try {
        return await browserCircuitBreaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config);
            if (type === 'search') {
                const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).query;
                if (!query) throw new Error('Search task requires a query');
                return (await scheduler.runSearch(query, config)) as T;
            }

            const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).url;
            if (url) {
                return (await scheduler.runScrape(url, config)) as T;
            }

            throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
        });
    } catch (error: any) {
        if (signal?.aborted || error.message === 'Aborted') throw new Error('Aborted');

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: type,
                taskType: type,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during ${type} task (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            if (isPoolShutdownError(error)) {
                // Pool is temporarily draining — wait for the drain to finish.
                // Do NOT call forceSchedulerRestart here: it would shut down the new scheduler
                // instance and restart the drain cycle, compounding the problem.
                logger.warn(`[BrowserManager] Pool is draining — waiting for pool idle before retry...`);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            } else {
                // True socket/connection error — restart the scheduler and wait for idle.
                logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                await forceSchedulerRestart(true);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            }
            // Small buffer after pool is confirmed idle to allow port reclamation.
            await new Promise(resolve => setTimeout(resolve, 500));
            return runBrowserTask<T>(taskOrUrl, type, config, retries - 1);
        }
        throw error;
    }
}

/**
 * Run a browser health check with retry logic.
 */
export async function runBrowserHealthCheck(config?: Config, retries = 1): Promise<{ success: boolean }> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config);
            return await scheduler.runHealthCheck(config);
        });
    } catch (error: any) {
        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'healthcheck',
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during healthcheck (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            if (isPoolShutdownError(error)) {
                logger.warn(`[BrowserManager] Pool is draining — waiting for pool idle before retry...`);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            } else {
                logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                await forceSchedulerRestart(true);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            return runBrowserHealthCheck(config, retries - 1);
        }
        throw error;
    }
}

/**
 * Run a worker search query with retry logic.
 */
export async function runWorkerSearch(query: string, config?: Config, signal?: AbortSignal, retries = 1): Promise<SearchResult[]> {
    if (signal?.aborted) throw new Error('Aborted');
    
    try {
        return await browserCircuitBreaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config);
            return await scheduler.runSearch(query, config);
        });
    } catch (error: any) {
        if (signal?.aborted || error.message === 'Aborted') throw new Error('Aborted');

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'search',
                query,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during search (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            if (isPoolShutdownError(error)) {
                logger.warn(`[BrowserManager] Pool is draining — waiting for pool idle before retry...`);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            } else {
                logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
                await forceSchedulerRestart(true);
                await waitForBrowserPoolIdle(15000).catch(() => {});
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            return runWorkerSearch(query, config, retries - 1);
        }
        throw error;
    }
}