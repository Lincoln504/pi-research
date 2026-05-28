/**
 * Browser Task Scheduler
 *
 * Manages the browser task scheduler lifecycle and task execution.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import type { SearchResult } from '../../web-research/types.ts';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { getService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { ISchedulerInternals } from '../../core/interfaces/scheduler-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import { BrowserServer } from './browser-server.ts';
import type { WorkerPoolManager } from './worker-pool-manager.ts';
import type { IScheduler } from '../../core/interfaces/scheduler-interfaces.ts';
import { cleanupOrphanedCamoufoxProcesses } from './browser-cleanup.ts';

/**
 * Browser task scheduler - manages the worker pool and executes tasks.
 * Only the leader process has an instance of this scheduler.
 */
export class BrowserTaskScheduler implements IScheduler {
    private workerPoolManager: WorkerPoolManager | null = null;
    private server: BrowserServer | null = null;
    private leadershipTimer: any = null;
    private idleTimer: any = null;
    private consecutiveLeadershipMisses: number = 0;
    private readonly LEADERSHIP_MISS_THRESHOLD: number = 5;
    private isShuttingDown: boolean = false;
    private readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — must outlast the embedding phase for large documents (can take 20+ min on CPU)

    constructor(
        public readonly schedulerId: string,
        private readonly stateManager: IStateManager
    ) {
        this.startLeadershipCheck();
        this.resetIdleTimer();
    }

    private async getWorkerPoolManager(): Promise<WorkerPoolManager> {
        if (!this.workerPoolManager) {
            this.workerPoolManager = await getService<WorkerPoolManager>(ServiceNames.WORKER_POOL_MANAGER);
            await this.workerPoolManager.initialize();
        }
        return this.workerPoolManager;
    }

    private startLeadershipCheck() {
        const check = async () => {
            if (this.isShuttingDown) return;
            
            try {
                const serverInfo = await this.stateManager.getBrowserServer();
                // If the state file now points to a different schedulerId, we have lost leadership
                if (serverInfo?.schedulerId !== this.schedulerId) {
                    this.consecutiveLeadershipMisses++;
                    metrics.increment('browser_leadership_misses_total', 1);
                    metrics.setGauge('browser_is_leader', 0);
                    logger.warn(`[Scheduler] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) - ID: ${this.schedulerId}, Current: ${serverInfo?.schedulerId}`);

                    if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
                        metrics.increment('browser_leadership_lost_total', 1);
                        logger.error(`[Scheduler] Leadership threshold exceeded (${this.consecutiveLeadershipMisses} misses), shutting down pool...`);
                        await this.shutdown();
                        return; // Stop checking after shutdown
                    }
                } else {
                    // Reset counter on successful leadership check
                    if (this.consecutiveLeadershipMisses > 0) {
                        logger.log(`[Scheduler] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
                        this.consecutiveLeadershipMisses = 0;
                    }
                    metrics.setGauge('browser_is_leader', 1);
                }
                
                // Decay the consecutive error counter
                const poolManager = await this.getWorkerPoolManager();
                poolManager.resetConsecutiveErrors();
            } catch (err) {
                logger.warn('[Scheduler] Leadership check error:', err);
            } finally {
                if (!this.isShuttingDown) {
                    this.leadershipTimer = setTimeout(check, 30000);
                    if (this.leadershipTimer.unref) this.leadershipTimer.unref();
                }
            }
        };

        this.leadershipTimer = setTimeout(check, 30000);
        if (this.leadershipTimer.unref) this.leadershipTimer.unref();
    }

    private resetIdleTimer() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            logger.log('[Scheduler] Browser pool idle timeout reached, shutting down...');
            this.shutdown();
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
        return this.server.start();
    }

    async runSearch(query: string, config?: Config): Promise<SearchResult[]> {
        // Activity on the server should keep the idle timer alive. This matters when
        // this process is the leader and another process (BrowserClient) is calling
        // us via HTTP — getScheduler() only resets the timer on the caller side,
        // so we must also reset it here on every inbound operation.
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();

        // Worker does at most 2 page loads at 12s each; 30s gives a buffer without
        // blocking Promise.all for 2 minutes when DuckDuckGo is slow or Cloudflare blocks.
        // However, we must add a generous 120s safety buffer for the task to wait in the worker pool queue.
        // The worker itself enforces its own strict internal timeouts for the actual browser operations.
        const baseTimeoutMs = (config || getConfig()).BROWSER_TASK_TIMEOUT_MS;
        const timeoutMs = baseTimeoutMs + 120000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Search task timed out after ${timeoutMs}ms (including queue wait)`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: { results: SearchResult[], error?: string };
        try {
            result = await Promise.race([
                pool.execute({ type: 'search', query, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                timeoutPromise
            ]) as { results: SearchResult[], error?: string };
        } catch (error) {
            metrics.increment('browser_search_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'search',
                query,
                taskType: 'search',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
        }

        const duration = Date.now() - startTime;
        metrics.observe('browser_search_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_search_requests_total', 1, { status: 'success' });
        logger.debug(`[Scheduler] Search task completed in ${duration}ms: ${query}`);
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

    async runScrape(url: string, config?: Config): Promise<any> {
        this.resetIdleTimer(); // Keep server alive while clients are actively scraping
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        // Add a generous 120s safety buffer to account for worker queueing. The worker itself
        // enforces the actual SCRAPE_TIMEOUT_MS limit on the browser operations.
        const baseTimeoutMs = (config || getConfig()).SCRAPE_TIMEOUT_MS;
        const timeoutMs = baseTimeoutMs + 120000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Scrape task timed out after ${timeoutMs}ms (including queue wait)`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: any;
        try {
            result = await Promise.race([
                pool.execute({ type: 'scrape', url, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                timeoutPromise
            ]);
        } catch (error) {
            metrics.increment('browser_scrape_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'browser-task',
                taskType: 'scrape',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
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

    async runHealthCheck(config?: Config): Promise<{ success: boolean }> {
        this.resetIdleTimer(); // Keep server alive during active health-checks from clients
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        // Add a generous safety buffer to account for worker queueing.
        const timeoutMs = 45000 + 60000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms (including queue wait)`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: { success: boolean; error?: string };
        try {
            result = await Promise.race([
                pool.execute({ type: 'healthcheck', queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                timeoutPromise
            ]) as { success: boolean; error?: string };
        } catch (error) {
            metrics.increment('browser_healthcheck_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'healthcheck',
                taskType: 'healthcheck',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
        }

        const duration = Date.now() - startTime;
        metrics.observe('browser_healthcheck_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_healthcheck_requests_total', 1, { status: 'success' });
        metrics.setGauge('browser_pool_health', 1); // Health check passed
        logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
        if (result.error) {
            metrics.increment('browser_healthcheck_requests_total', 1, { status: 'error' });
            metrics.setGauge('browser_pool_health', 0); // Health check failed
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

        // Clear reference immediately to prevent new tasks from using this scheduler
        const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER);
        const currentScheduler = schedulerService.getSchedulerInstance();
        if (currentScheduler && 'schedulerId' in currentScheduler && currentScheduler.schedulerId === this.schedulerId) {
            schedulerService.setSchedulerInstance(null);
            schedulerService.setSchedulerVersion(null);
            schedulerService.setSchedulerInitializationPromise(null);
        }

        let serverInfo: { port: number; pid: number; schedulerId?: string } | null = null;
        try {
            serverInfo = await this.stateManager.getBrowserServer();
        } catch (err) {
            logger.warn('[Scheduler] Could not read browser server state during shutdown (state manager may be disposed):', err);
        }
        // Only clear state if this scheduler still owns it — same pid AND same schedulerId.
        // Checking pid alone is wrong when a new scheduler wins election in the same process:
        // the old scheduler's shutdown would wipe the new leader's registration.
        if (serverInfo?.pid === process.pid && serverInfo?.schedulerId === this.schedulerId) {
            await this.stateManager.clearBrowserServer().catch((err) => {
                logger.warn('[Scheduler] Failed to clear browser server state during shutdown:', err);
            });
        }

        if (this.server) {
            try {
                // Use a timeout for server shutdown
                await Promise.race([
                    this.server.stop(),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            } catch (e) {
                logger.warn('[Scheduler] Server shutdown error:', e);
            }
            this.server = null;
        }

        // Shutdown the worker pool
        if (this.workerPoolManager) {
            await this.workerPoolManager.shutdown();
        }

        // Clean up any orphaned Camoufox browser processes that may have been left behind
        // This handles edge cases where workers were force-killed or hung during teardown
        try {
            await cleanupOrphanedCamoufoxProcesses();
        } catch (cleanupError) {
            const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            logger.warn('[Scheduler] Failed to cleanup orphaned browsers:', msg);
        }
    }
}