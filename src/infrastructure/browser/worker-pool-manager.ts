/**
 * Worker Pool Manager
 *
 * Manages the lifecycle of the worker pool for browser operations.
 * Extracted from BrowserTaskScheduler for better separation of concerns.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixedClusterPool, WorkerChoiceStrategies } from 'poolifier';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import { ensureBrowserCacheDir, getBrowserEnv, getMaxWorkers } from './config.ts';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Sanitize the current process.argv before pool initialization to prevent
 * research queries from leaking into worker process command lines.
 * This is a temporary measure for the duration of pool creation.
 *
 * Note: Poolifier's FixedClusterPool uses cluster.fork() which inherits the
 * parent's argv. We temporarily sanitize it during pool creation to minimize
 * query exposure in worker process command lines visible via ps aux.
 */
function sanitizeArgvForPoolCreation(): () => void {
    const originalArgv = [...process.argv];
    process.argv = originalArgv.slice(0, 2);
    return () => { process.argv = originalArgv; };
}

/**
 * Worker pool manager for browser operations.
 */
export class WorkerPoolManager implements IService {
    readonly name = 'worker-pool-manager';
    lifecycle = ServiceLifecycle.UNINITIALIZED;

    private pool: any | null = null;
    private poolInitializationPromise: Promise<any> | null = null;
    private currentWorkerCount: number | null = null;
    private consecutiveErrors: number = 0;
    private isShuttingDown: boolean = false;

    constructor(
        private readonly onPoolError?: (error: Error, consecutiveErrors: number) => void
    ) {}

    /**
     * Ensure the pool is initialized with the current config.
     * Recreates the pool if the worker count has changed.
     */
    async ensurePool(config?: Config): Promise<any> {
        const maxWorkers = getMaxWorkers(config);

        // Fast-fail if a shutdown is in progress — the caller should retry after
        // the shutdown completes (isShuttingDown is reset to false on completion).
        // This check must come BEFORE the cached-pool fast-path below because
        // pool.destroy() may be in flight while this.pool is still non-null.
        // Returning a mid-destroy pool would cause poolifier to throw
        // "Cannot execute a task on destroying pool".
        if (this.isShuttingDown) {
            throw new Error('Worker pool is shutting down');
        }

        // If pool exists, worker count matches, and we are not shutting down,
        // return the existing pool immediately.
        if (this.pool && this.currentWorkerCount === maxWorkers) {
            return this.pool;
        }

        // Use a promise to coalesce concurrent initialization calls
        if (this.poolInitializationPromise) {
            return this.poolInitializationPromise;
        }

        this.poolInitializationPromise = (async () => {
            try {
                if (this.pool && this.currentWorkerCount !== maxWorkers) {
                    logger.log(`[WorkerPoolManager] Worker count changed from ${this.currentWorkerCount} to ${maxWorkers}, recreating pool...`);
                    await this.pool.destroy();
                    this.pool = null;
                }

                this.currentWorkerCount = maxWorkers;

                logger.log(`[WorkerPoolManager] Initializing Unified FixedClusterPool (Size: ${maxWorkers}) on PID ${process.pid}`);

                ensureBrowserCacheDir();
                const browserEnv = getBrowserEnv();

                // Sanitize argv to prevent research query exposure in worker processes
                const restoreArgv = sanitizeArgvForPoolCreation();

                const workerConcurrency = (config || getConfig()).WORKER_CONCURRENCY;

                // thread-worker.mjs is the esbuild-compiled bundle of thread-worker.ts and its
                // local imports. Using a pre-compiled JS file eliminates any TypeScript loading
                // concern in cluster child processes — no execArgv loader flags needed.
                this.pool = new FixedClusterPool(maxWorkers, join(__dirname, './thread-worker.mjs'), {
                    env: browserEnv,
                    errorHandler: (e: Error) => {
                        this.consecutiveErrors++;
                        metrics.increment('browser_pool_errors_total', 1);
                        logger.error('[WorkerPoolManager] Cluster Error:', e);
                        if (this.consecutiveErrors >= 3) {
                            metrics.increment('browser_pool_unhealthy_events_total', 1);
                            logger.error(`[WorkerPoolManager] Worker pool may be unhealthy: ${this.consecutiveErrors} consecutive errors. Consider restarting.`);
                            if (this.onPoolError) {
                                this.onPoolError(e, this.consecutiveErrors);
                            }
                            this.schedulePoolReset();
                        }
                    },
                    exitHandler: (code: number) => {
                        // null exit code means the worker was killed intentionally (e.g. pool.destroy())
                        if (code !== 0 && code !== null) {
                            logger.error(`[WorkerPoolManager] Worker exited with code ${code}`);
                            this.consecutiveErrors++;
                            if (this.consecutiveErrors >= 3) {
                                logger.error(`[WorkerPoolManager] Worker pool unhealthy due to 3 consecutive exits. Scheduling auto-recovery...`);
                                if (this.onPoolError) {
                                    this.onPoolError(new Error(`Worker exited with code ${code}`), this.consecutiveErrors);
                                }
                                this.schedulePoolReset();
                            }
                        }
                    },
                    workerChoiceStrategy: WorkerChoiceStrategies.ROUND_ROBIN,
                    enableTasksQueue: true,
                    tasksQueueOptions: {
                        concurrency: workerConcurrency, // configurable via PI_RESEARCH_WORKER_CONCURRENCY
                    }
                });

                // Restore original argv after pool is created
                restoreArgv();

                // Secondary race check: if shutdown() was called concurrent with the
                // async pool construction above (between the early check and here).
                if (this.isShuttingDown) {
                    logger.warn('[WorkerPoolManager] Pool initialized but is already shutting down. Destroying...');
                    await this.pool.destroy().catch(() => {});
                    this.pool = null;
                    throw new Error('Worker pool is shutting down');
                }

                metrics.setGauge('browser_pool_workers', maxWorkers);
                metrics.increment('browser_pool_initializations_total', 1, { success: 'true' });

                return this.pool;
            } catch (error) {
                metrics.increment('browser_pool_initializations_total', 1, { success: 'false' });
                throw error;
            } finally {
                this.poolInitializationPromise = null;
            }
        })();

        return this.poolInitializationPromise;
    }

    /**
     * Get the current pool instance.
     */
    getPool(): any | null {
        return this.pool;
    }

    /**
     * Reset consecutive errors counter.
     */
    resetConsecutiveErrors(): void {
        this.consecutiveErrors = 0;
    }

    /**
     * Schedule an out-of-band pool reset. Called from poolifier event handlers
     * where destroying the pool synchronously would deadlock. Waits 1 s so the
     * current event-handler call-stack unwinds before the pool is destroyed.
     */
    private schedulePoolReset(): void {
        if (this.isShuttingDown) return;
        const deadPool = this.pool;
        this.pool = null;
        this.currentWorkerCount = null;
        this.consecutiveErrors = 0;
        metrics.increment('browser_pool_auto_recoveries_total', 1);
        logger.info('[WorkerPoolManager] Pool reference dropped for auto-recovery; next ensurePool() will create a fresh pool.');
        // Destroy the old pool asynchronously after the event handler returns.
        const t = setTimeout(async () => {
            try {
                if (deadPool) await deadPool.destroy();
                logger.info('[WorkerPoolManager] Auto-recovery: old pool destroyed.');
            } catch (err) {
                logger.warn('[WorkerPoolManager] Auto-recovery: error destroying old pool:', err);
            }
        }, 1000);
        if (t.unref) t.unref();
    }

    /**
     * Check if the pool is shutting down.
     */
    isPoolShuttingDown(): boolean {
        return this.isShuttingDown;
    }

    /**
     * Destroy the pool and clean up resources.
     */
    async shutdown(): Promise<void> {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        if (this.pool) {
            try {
                // Use a timeout for pool destruction. Workers run async browser teardown
                // in their killHandler (context.close / browser.close via Playwright), so
                // allow enough time for those to complete before the IPC channel closes.
                await Promise.race([
                    this.pool.destroy(),
                    new Promise(resolve => setTimeout(resolve, 5000))
                ]);
            } catch (e) {
                logger.warn('[WorkerPoolManager] Pool destruction error:', e);
            }
            // Allow a brief moment for IPC channels and worker browser teardown to complete.
            // Reduced from 1500ms to 200ms because browser processes are now also
            // explicitly cleaned up by the scheduler via killBrowserProcesses.
            await new Promise(resolve => setTimeout(resolve, 200));
            this.pool = null;
        }

        this.poolInitializationPromise = null;
        this.currentWorkerCount = null;
        this.consecutiveErrors = 0;
        // Reset so this instance can be re-used after shutdown — the service
        // registry keeps the same WorkerPoolManager instance across scheduler
        // restarts, so without this reset ensurePool() would permanently throw.
        this.isShuttingDown = false;
    }

    async initialize(): Promise<void> {
        if (this.lifecycle === ServiceLifecycle.INITIALIZED) {
            return;
        }
        this.lifecycle = ServiceLifecycle.INITIALIZING;
        logger.debug('[WorkerPoolManager] Initializing...');
        this.lifecycle = ServiceLifecycle.INITIALIZED;
        logger.debug('[WorkerPoolManager] Initialized');
    }

    async dispose(): Promise<void> {
        if (this.lifecycle === ServiceLifecycle.DISPOSED) {
            return;
        }
        this.lifecycle = ServiceLifecycle.DISPOSING;
        logger.debug('[WorkerPoolManager] Disposing...');
        await this.shutdown();
        this.lifecycle = ServiceLifecycle.DISPOSED;
        logger.debug('[WorkerPoolManager] Disposed');
    }
}
