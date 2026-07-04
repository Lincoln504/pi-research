/**
 * Browser Task Scheduler
 *
 * Manages the browser task scheduler lifecycle and task execution.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import type { SearchResult, ScrapeResult } from '../../web-research/types.ts';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { getService, getServiceContainer } from '../../core/service-registry.ts';
import type { ServiceContainer } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { ISchedulerInternals } from '../../core/interfaces/scheduler-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import { BrowserServer, getBrowserServerAuthSecret } from './browser-server.ts';
import { isPoolShutdownError } from './browser-error-utils.ts';
import type { WorkerPoolManager } from './worker-pool-manager.ts';
import type { IScheduler } from '../../core/interfaces/scheduler-interfaces.ts';
import { cleanupOrphanedCamoufoxProcesses, getBrowserPidsForWorkers, killBrowserProcesses } from './browser-cleanup.ts';
import { raceWithDeadline } from '../../utils/safe-unref.ts';
import { PriorityTaskQueue } from './priority-task-queue.ts';

/**
 * Browser task scheduler - manages the worker pool and executes tasks.
 * Only the leader process has an instance of this scheduler.
 */
export class BrowserTaskScheduler implements IScheduler {
    private workerPoolManager: WorkerPoolManager | null = null;
    private server: BrowserServer | null = null;
    private priorityQueue: PriorityTaskQueue | null = null;
    private leadershipTimer: any = null;
    private leadershipMonitorStarted: boolean = false;
    private idleTimer: any = null;
    private consecutiveLeadershipMisses: number = 0;
    private readonly LEADERSHIP_CHECK_INTERVAL_MS: number = 5000;
    private readonly LEADERSHIP_MISS_THRESHOLD: number = 3;
    private isShuttingDown: boolean = false;
    private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (was 30min — wasted RAM)

    constructor(
        public readonly schedulerId: string,
        private readonly stateManager: IStateManager,
        private readonly container: ServiceContainer = getServiceContainer()
    ) {
        // NB: the leadership monitor is NOT started here. The leadership check
        // compares the persisted browserServer.schedulerId against ours, but this
        // scheduler does not register itself as leader until AFTER construction
        // (startServer + the lock-contended election updateState in the factory).
        // Arming the timer in the constructor meant that, under lock contention,
        // the first checks could fire before registration completed, accumulate
        // misses, and self-shut-down a scheduler that was still legitimately
        // becoming the leader. The factory calls startLeadershipMonitor() once the
        // election is won. The idle timer has no such dependency and starts now.
        this.resetIdleTimer();
    }

    /**
     * Start the periodic leadership check. Called by the scheduler factory AFTER
     * this process has won the election and registered itself as leader, so the
     * check never races its own registration. Idempotent.
     */
    public startLeadershipMonitor(): void {
        if (this.leadershipMonitorStarted || this.isShuttingDown) return;
        this.leadershipMonitorStarted = true;
        this.startLeadershipCheck();
    }

    private async getWorkerPoolManager(): Promise<WorkerPoolManager> {
        if (!this.workerPoolManager) {
            this.workerPoolManager = await getService<WorkerPoolManager>(ServiceNames.WORKER_POOL_MANAGER, undefined, this.container);
            await this.workerPoolManager.initialize();
        }
        return this.workerPoolManager;
    }

    /**
     * Get or create the priority task queue.
     * This is synchronous to prevent races where multiple concurrent requests
     * might create redundant queue instances before the reference is set.
     */
    private getPriorityQueue(config?: Config): PriorityTaskQueue {
        const c = config || getConfig();
        const maxTotalConcurrency = c.WORKER_THREADS * c.WORKER_CONCURRENCY;
        if (!this.priorityQueue) {
            this.priorityQueue = new PriorityTaskQueue(maxTotalConcurrency);
        } else {
            this.priorityQueue.updateConcurrency(maxTotalConcurrency);
        }
        return this.priorityQueue;
    }

    private startLeadershipCheck() {
        const check = async () => {
            if (this.isShuttingDown) return;
            
            try {
                const serverInfo = await this.stateManager.getBrowserServer();
                if (serverInfo?.schedulerId !== this.schedulerId) {
                    this.consecutiveLeadershipMisses++;
                    metrics.increment('browser_leadership_misses_total', 1);
                    metrics.setGauge('browser_is_leader', 0);
                    logger.warn(`[Scheduler] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) - ID: ${this.schedulerId}, Current: ${serverInfo?.schedulerId}`);

                    if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
                        metrics.increment('browser_leadership_lost_total', 1);
                        logger.error(`[Scheduler] Leadership threshold exceeded (${this.consecutiveLeadershipMisses} misses), shutting down pool...`);
                        await this.shutdown();
                        return;
                    }
                } else {
                    if (this.consecutiveLeadershipMisses > 0) {
                        logger.log(`[Scheduler] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
                        this.consecutiveLeadershipMisses = 0;
                    }
                    metrics.setGauge('browser_is_leader', 1);
                }
                
                const poolManager = await this.getWorkerPoolManager();
                // Decay (not reset) so a slow worker crash-loop can still accumulate to
                // the auto-recovery threshold instead of being zeroed on every tick.
                poolManager.decayConsecutiveErrors();
            } catch (err) {
                logger.warn('[Scheduler] Leadership check error:', err);
            } finally {
                if (!this.isShuttingDown) {
                    this.leadershipTimer = setTimeout(check, this.LEADERSHIP_CHECK_INTERVAL_MS);
                    if (this.leadershipTimer.unref) this.leadershipTimer.unref();
                }
            }
        };

        this.leadershipTimer = setTimeout(check, this.LEADERSHIP_CHECK_INTERVAL_MS);
        if (this.leadershipTimer.unref) this.leadershipTimer.unref();
    }

    private resetIdleTimer() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            logger.log('[Scheduler] Browser pool idle timeout reached, shutting down...');
            // shutdown() is async and awaits getService()/server.stop(); a rejection here (e.g.
            // getService throwing during a concurrent container disposal) would otherwise surface
            // as an unhandledRejection from this fire-and-forget timer. Swallow it — an idle
            // teardown that fails is non-fatal; the next run gets a fresh scheduler regardless.
            this.shutdown().catch(err => logger.warn('[Scheduler] Idle-timeout shutdown failed (non-fatal):', err));
        }, this.IDLE_TIMEOUT_MS);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    public resetIdleTimerOnActivity(): void {
        this.resetIdleTimer();
    }

    async startServer(): Promise<number> {
        this.server = new BrowserServer({
            onSearch: (q) => this.runSearch(q),
            onScrape: (u) => this.runScrape(u),
            onHealthCheck: () => this.runHealthCheck(),
        });
        // FIX (#21): Expose auth secret to child processes via env
        process.env['PI_BROWSER_AUTH_SECRET'] = getBrowserServerAuthSecret();
        return this.server.start();
    }

    async runSearch(query: string, config?: Config, signal?: AbortSignal): Promise<SearchResult[]> {
        // Reject tasks once this scheduler has begun teardown. shutdown() nulls priorityQueue and
        // clears the scheduler reference (a future run gets a fresh scheduler), so getPriorityQueue()
        // here would otherwise build a FRESH, non-shutdown queue on this dead instance and dispatch
        // onto a pool being destroyed. The message matches isPoolShutdownError → benign DEBUG for callers.
        if (this.isShuttingDown) throw new Error('Worker pool is shutting down');
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();

        // Task timeout = the search nav budget (SEARCH_TIMEOUT_MS) + a queue-wait/overhead
        // margin (BROWSER_TASK_TIMEOUT_MS). Deriving from SEARCH_TIMEOUT_MS keeps the task
        // ceiling coherent with the worker's own nav timeout — using a flat base here would
        // kill a search before it had used its full nav budget.
        const cfg = config || getConfig();
        const timeoutMs = cfg.SEARCH_TIMEOUT_MS + cfg.BROWSER_TASK_TIMEOUT_MS;

        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Search task timed out after ${timeoutMs}ms (including queue wait). query="${query}"`));
            }, timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        logger.debug(`[BrowserTaskScheduler] Executing search: "${query}" (Timeout: ${timeoutMs}ms)`);
        let result: any;
        try {
            const queue = this.getPriorityQueue(config);
            // Race the enqueue call against the timeoutPromise.
            // This ensures that even if the queue is saturated, we won't hang forever.
            result = await Promise.race([
                queue.enqueue('search', async () => {
                    return await Promise.race([
                        pool.execute({ type: 'search', query, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                        timeoutPromise
                    ]);
                }, signal),
                timeoutPromise
            ]);
            logger.debug(`[BrowserTaskScheduler] Search completed: "${query}" in ${Date.now() - startTime}ms`);
        } catch (error) {
            // A pool-shutdown/destroy error means the run is being torn down (quit/SIGTERM
            // mid-search-burst): the task never ran because dispose() destroyed the pool.
            // That is expected teardown, not a fault — log at DEBUG and don't count it toward
            // the error metric/tracker, so a normal quit-mid-run doesn't inflate ERROR counts.
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Search abandoned during shutdown: "${query}"`);
                throw error;
            }
            logger.error(`[BrowserTaskScheduler] Search failed: "${query}"`, error);
            metrics.increment('browser_search_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'search',
                query,
                taskType: 'search',
            });
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        metrics.observe('browser_search_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_search_requests_total', 1, { status: 'success' });
        if (result.error) {
            metrics.increment('browser_search_requests_total', 1, { status: 'error' });
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'search',
                query,
                taskType: 'search',
                errorType: 'search_error',
            });
            throw new Error(result.error);
        }
        return result.results;
    }

    async runScrape(url: string, config?: Config, signal?: AbortSignal): Promise<ScrapeResult> {
        if (this.isShuttingDown) throw new Error('Worker pool is shutting down');
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        // Task timeout = the scrape nav budget (SCRAPE_TIMEOUT_MS) + the queue-wait/overhead
        // margin (BROWSER_TASK_TIMEOUT_MS), mirroring the search path so both stay coherent.
        const cfg = config || getConfig();
        const isMocking = process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
        const timeoutMs = cfg.SCRAPE_TIMEOUT_MS + (isMocking ? 5000 : cfg.BROWSER_TASK_TIMEOUT_MS);

        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Scrape task timed out after ${timeoutMs}ms (including queue wait). url="${url}"`));
            }, timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: any;
        try {
            const queue = this.getPriorityQueue(config);
            result = await Promise.race([
                queue.enqueue('scrape', async () => {
                    return await Promise.race([
                        pool.execute({ type: 'scrape', url, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                        timeoutPromise
                    ]);
                }, signal),
                timeoutPromise
            ]);
        } catch (error) {
            // Pool-shutdown/destroy mid-scrape is expected teardown (quit/SIGTERM), not a
            // fault — demote to DEBUG and don't inflate the error metric/tracker (mirrors runSearch).
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Scrape abandoned during shutdown: "${url}"`);
                throw error;
            }
            metrics.increment('browser_scrape_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'browser-task',
                taskType: 'scrape',
            });
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        metrics.observe('browser_scrape_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_scrape_requests_total', 1, { status: 'success' });
        if (result.error) {
            metrics.increment('browser_scrape_requests_total', 1, { status: 'error' });
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'browser-task',
                taskType: 'scrape',
                errorType: 'scrape_error',
            });
            throw new Error(result.error);
        }
        return result;
    }

    async runHealthCheck(config?: Config, signal?: AbortSignal): Promise<{ success: boolean }> {
        if (this.isShuttingDown) throw new Error('Worker pool is shutting down');
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        const isMocking = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' || process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
        const timeoutMs = (45000 + 60000) / (isMocking ? 4 : 1);
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms (including queue wait)`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: { success: boolean; error?: string };
        try {
            const queue = this.getPriorityQueue(config);
            result = await Promise.race([
                queue.enqueue('healthcheck', async () => {
                    const execPromise = pool.execute({ type: 'healthcheck', queuedAt: startTime, taskTimeoutMs: timeoutMs });
                    execPromise.catch((err: Error) => logger.debug(`[BrowserTaskScheduler] Background healthcheck task rejection: ${err.message}`));
                    return await Promise.race([
                        execPromise,
                        timeoutPromise
                    ]);
                }, signal),
                timeoutPromise
            ]) as { success: boolean; error?: string };
        } catch (error) {
            // Pool-shutdown/destroy mid-healthcheck is expected teardown, not a fault —
            // demote to DEBUG and don't inflate the error metric/tracker (mirrors runSearch).
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Healthcheck abandoned during shutdown`);
                throw error;
            }
            metrics.increment('browser_healthcheck_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'healthcheck',
                taskType: 'healthcheck',
            });
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        const duration = Date.now() - startTime;
        metrics.observe('browser_healthcheck_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_healthcheck_requests_total', 1, { status: 'success' });
        metrics.setGauge('browser_pool_health', 1);
        logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
        if (result.error) {
            metrics.increment('browser_healthcheck_requests_total', 1, { status: 'error' });
            metrics.setGauge('browser_pool_health', 0);
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'healthcheck',
                taskType: 'healthcheck',
                errorType: 'healthcheck_error',
            });
            throw new Error(result.error);
        }
        return result;
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        if (this.leadershipTimer) {
            clearTimeout(this.leadershipTimer);
            this.leadershipTimer = null;
        }

        // Clear our reference from the SchedulerService so a future run gets a
        // fresh scheduler. Skip this entirely when the container is being
        // disposed: getService() throws during disposal, and the SchedulerService
        // (and the whole container) is being torn down anyway, so the cleared
        // reference would be moot. Guarding here keeps shutdown from logging a
        // spurious "Cannot get service 'scheduler' during container disposal".
        if (!this.container.isDisposing) {
            const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER, undefined, this.container);
            const currentScheduler = schedulerService.getSchedulerInstance();
            if (currentScheduler && 'schedulerId' in currentScheduler && currentScheduler.schedulerId === this.schedulerId) {
                schedulerService.setSchedulerInstance(null);
                schedulerService.setSchedulerVersion(null);
                schedulerService.setSchedulerInitializationPromise(null);
            }
        }

        let serverInfo: { port: number; pid: number; schedulerId?: string } | null = null;
        try {
            serverInfo = await this.stateManager.getBrowserServer();
        } catch (err) {
            logger.warn('[Scheduler] Could not read browser server state during shutdown:', err);
        }
        if (serverInfo?.pid === process.pid && serverInfo?.schedulerId === this.schedulerId) {
            await this.stateManager.clearBrowserServer().catch((err) => {
                logger.warn('[Scheduler] Failed to clear browser server state during shutdown:', err);
            });
        }

        if (this.server) {
            try {
                await raceWithDeadline(this.server.stop(), 2000);
            } catch (e) {
                logger.warn('[Scheduler] Server shutdown error:', e);
            }
            this.server = null;
        }

        let targetBrowserPids: number[] = [];
        if (this.workerPoolManager) {
            const pool = this.workerPoolManager.getPool();
            if (pool && pool.workerNodes) {
                const workerPids = pool.workerNodes.map((n: any) => n.worker?.process?.pid).filter(Boolean);
                if (workerPids.length > 0) {
                    targetBrowserPids = await getBrowserPidsForWorkers(workerPids);
                }
            }
        }

        if (this.priorityQueue) {
            this.priorityQueue.shutdown();
            this.priorityQueue = null;
        }

        if (this.workerPoolManager) {
            await this.workerPoolManager.shutdown();
        }

        if (targetBrowserPids.length > 0) {
            await raceWithDeadline(killBrowserProcesses(targetBrowserPids), 10000);
        }

        try {
            const orphanPromise = cleanupOrphanedCamoufoxProcesses();
            orphanPromise.catch((err: Error) => logger.debug(`[BrowserTaskScheduler] Background orphan cleanup rejection: ${err.message}`));
            await raceWithDeadline(orphanPromise, 15000);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('[Scheduler] Failed to cleanup orphaned browsers:', msg);
        }
    }
}
