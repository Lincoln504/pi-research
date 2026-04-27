/**
 * Browser Manager
 *
 * UNIFIED TASK SCHEDULER using FIXED THREAD POOL:
 * 1. Search Tasks: Offloaded to Poolifier Thread Workers.
 * 2. Scrape Tasks: Offloaded to Poolifier Thread Workers.
 * 3. Health Checks: Offloaded to Poolifier Thread Workers.
 * 
 * Ensures a maximum of 3 browser processes globally across all tasks and sessions.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedThreadPool, WorkerChoiceStrategies } from 'poolifier';
import type { SearchResult } from '../web-research/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const MAX_WORKERS = 3;

class BrowserTaskScheduler {
    private pool: FixedThreadPool;
    private searchCounter = 0;
    private isHealthChecking = false;

    constructor() {
        logger.log(`[Scheduler] Initializing Unified FixedThreadPool (Size: ${MAX_WORKERS})`);
        this.pool = new FixedThreadPool(MAX_WORKERS, join(__dirname, 'thread-worker.mjs'), {
            errorHandler: (e: Error) => logger.error('[Scheduler] Thread Error:', e),
            workerChoiceStrategy: WorkerChoiceStrategies.LEAST_USED,
            enableTasksQueue: true, // Allow queuing if all 3 workers are busy
            tasksQueueOptions: { concurrency: 1 }
        });
    }

    async runSearch(query: string): Promise<SearchResult[]> {
        // PERIODIC HEALTH CHECK: fire-and-forget so the search is not blocked
        if (this.searchCounter % 20 === 0 && !this.isHealthChecking) {
            this.isHealthChecking = true;
            this.pool.execute({ type: 'healthcheck' })
                .then((r) => {
                    if (!(r as { success: boolean }).success) {
                        logger.error('[Scheduler] Periodic health check failed. Possible IP block.');
                    }
                })
                .catch((e: Error) => logger.error('[Scheduler] Health check error:', e))
                .finally(() => { this.isHealthChecking = false; });
        }

        const result = (await this.pool.execute({ type: 'search', query })) as { results: SearchResult[], error?: string };
        if (result.error) throw new Error(result.error);

        this.searchCounter++;
        return result.results;
    }

    async runScrape(url: string): Promise<any> {
        const result = (await this.pool.execute({ type: 'scrape', url })) as any;
        if (result.error) throw new Error(result.error);
        return result;
    }

    async runHealthCheck(): Promise<{ success: boolean }> {
        const result = (await this.pool.execute({ type: 'healthcheck' })) as { success: boolean; error?: string };
        if (result.error) throw new Error(result.error);
        return result;
    }

    async shutdown() {
        await this.pool.destroy();
    }
}

let scheduler: BrowserTaskScheduler | null = null;

function getScheduler(): BrowserTaskScheduler {
    if (!scheduler) scheduler = new BrowserTaskScheduler();
    return scheduler;
}

const require = createRequire(import.meta.url);

export function isBrowserAvailable(): boolean {
  try {
    require.resolve('camoufox-js');
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatches a browser task to the unified worker pool.
 */
export async function runBrowserTask<T>(taskOrUrl: any, type: 'search' | 'scrape' = 'scrape'): Promise<T> {
    if (type === 'search') {
        const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).query;
        return getScheduler().runSearch(query) as any;
    }
    
    // For scrape, we either get a URL string or a task function (legacy support)
    const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).url;
    if (url) {
        return getScheduler().runScrape(url) as any;
    }

    // If it's the legacy function-style task, we can't easily run it in the worker,
    // so we throw to enforce the new data-only task architecture.
    throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
}

export async function runBrowserHealthCheck(): Promise<{ success: boolean }> {
    return getScheduler().runHealthCheck();
}

export async function runWorkerSearch(query: string): Promise<SearchResult[]> {
    return getScheduler().runSearch(query);
}

export async function stopBrowserManager(): Promise<void> {
  if (scheduler) {
      await scheduler.shutdown();
      scheduler = null;
  }
}

shutdownManager.register(stopBrowserManager);
