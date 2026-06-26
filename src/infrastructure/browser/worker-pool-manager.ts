/**
 * Worker Pool Manager
 *
 * Manages the lifecycle of the worker pool for browser operations.
 * Extracted from BrowserTaskScheduler for better separation of concerns.
 */

import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FixedClusterPool, WorkerChoiceStrategies } from 'poolifier';
import { logger } from '../../logger.ts';
import { metrics } from '../../utils/metrics.ts';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';
import { ensureBrowserCacheDir, getBrowserEnv, getBrowserProfileDir, getMaxWorkers } from './config.ts';
import { cleanupStaleProfiles } from './cleanup-utils.ts';
import { cleanupOrphanedCamoufoxProcesses } from './browser-cleanup.ts';
import { ServiceLifecycle, type IService } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/interfaces/service-names.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Worker pool manager for browser operations.
 */
export class WorkerPoolManager implements IService {
    readonly name = ServiceNames.WORKER_POOL_MANAGER;
    lifecycle = ServiceLifecycle.UNINITIALIZED;

    private pool: any | null = null;
    private poolInitializationPromise: Promise<any> | null = null;
    private currentWorkerCount: number | null = null;
    private consecutiveErrors: number = 0;
    private isShuttingDown: boolean = false;
    // FIX (#12): Flag to indicate a pool reset is in progress
    private _resetInProgress: boolean = false;

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

        // FIX (#12): If a pool reset is in progress, wait briefly and retry
        // instead of creating a duplicate pool.
        if (this._resetInProgress) {
            const maxWait = 3000;
            const interval = 100;
            const deadline = Date.now() + maxWait;
            while (this._resetInProgress && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, interval));
            }
            if (this._resetInProgress) {
                throw new Error('Worker pool is being reset, please retry');
            }
            // Reset complete — recurse once to get the fresh pool
            return this.ensurePool(config);
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
                const browserEnv = getBrowserEnv(config);

                // Reclaim browser profiles leaked by a previously crashed run
                // (Playwright self-cleans on a normal browser.close(); only an
                // abnormal exit leaves them behind — and on a tmpfs /tmp that is
                // leaked RAM). Lock-aware, so profiles in use by this or a
                // concurrent instance are spared. Fire-and-forget: never block
                // or fail pool startup. Sweeps the dedicated profile dir plus
                // the legacy os.tmpdir() location for pre-upgrade leftovers.
                const STALE_PROFILE_MS = 60 * 60 * 1000; // 1 hour
                void cleanupStaleProfiles(getBrowserProfileDir(config), STALE_PROFILE_MS)
                    .catch((e) => logger.debug('[WorkerPoolManager] Profile sweep (profile dir) failed:', e));
                void cleanupStaleProfiles(undefined, STALE_PROFILE_MS)
                    .catch((e) => logger.debug('[WorkerPoolManager] Profile sweep (legacy tmp) failed:', e));

                // SIGKILL backstop: reap Camoufox processes orphaned by a PRIOR run that
                // died abruptly (kill -9, crash) before its graceful shutdown could fire.
                // The sweep is pi-research-specific (matches our camoufox-bin / profile
                // marker, never the user's system Firefox) and orphan-aware (only kills
                // processes whose parent is dead), so camoufox owned by THIS or a concurrent
                // live instance is spared. Fire-and-forget; never block pool startup.
                void cleanupOrphanedCamoufoxProcesses()
                    .catch((e) => logger.debug('[WorkerPoolManager] Startup orphan sweep failed:', e));

                const workerConcurrency = (config || getConfig()).WORKER_CONCURRENCY;

                // thread-worker.mjs is the esbuild-compiled bundle of thread-worker.ts and its
                // local imports. Using a pre-compiled JS file eliminates any TypeScript loading
                // concern in cluster child processes — no execArgv loader flags needed.
                const workerPath = join(__dirname, './thread-worker.mjs');

                // Fail loud and actionable if the worker bundle is missing. It is built by the
                // `prepare` lifecycle (scripts/build.cjs), not committed to git, so a clone that
                // skipped install scripts (or a partial install) leaves it absent. Without this
                // guard poolifier throws an opaque ERR_MODULE_NOT_FOUND for the worker FILE and
                // then respawns workers forever — the exact crash-loop that masks the real cause.
                if (!existsSync(workerPath)) {
                    throw new Error(
                        `Browser worker bundle is missing at ${workerPath}. ` +
                        `It is produced by the build step; reinstall the extension (e.g. \`pi update --extensions\`) ` +
                        `or run \`npm install\` in the extension directory so the prepare/build script regenerates it.`,
                    );
                }

                this.pool = new FixedClusterPool(maxWorkers, workerPath, {
                    env: browserEnv,
                    // Prevent query leakage via process.argv in forked workers
                    workerOptions: { execArgv: [] },
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

                // Secondary race check: if shutdown() was called concurrent with the
                // async pool construction above (between the early check and here).
                if (this.isShuttingDown) {
                    logger.warn('[WorkerPoolManager] Pool initialized but is already shutting down. Destroying...');
                    await this.pool.destroy().catch((err: any) => logger.debug('Swallowed pool destroy error:', err));
                    this.pool = null;
                    throw new Error('Worker pool is shutting down');
                }

                metrics.setGauge('browser_pool_workers', maxWorkers);
                metrics.increment('browser_pool_initializations_total', 1, { success: 'true' });

                if (this.lifecycle === ServiceLifecycle.UNINITIALIZED) {
                    this.lifecycle = ServiceLifecycle.INITIALIZED;
                }

                // Clear the coalescing promise on success too (not only on failure).
                // Leaving a resolved promise here means a later ensurePool() call with a
                // CHANGED worker count — which skips the line-79 fast path — would return
                // this stale promise and hand back the OLD pool, silently ignoring the new
                // count. Concurrent callers already hold their own reference to this promise,
                // so clearing it is safe.
                this.poolInitializationPromise = null;

                return this.pool;
            } catch (error) {
                metrics.increment('browser_pool_initializations_total', 1, { success: 'false' });
                // Clean up the promise ONLY on failure, so next caller can retry.
                // On success, we keep it so concurrent callers get the same resolution.
                this.poolInitializationPromise = null;
                throw error;
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
        // FIX (#12): Don't nullify pool immediately — mark it as dead but keep the
        // reference so ensurePool() doesn't create a duplicate while the old one
        // is still being destroyed. Instead, use a flag to signal reset is in progress.
        this._resetInProgress = true;
        this.currentWorkerCount = null;
        this.consecutiveErrors = 0;
        metrics.increment('browser_pool_auto_recoveries_total', 1);
        logger.info('[WorkerPoolManager] Pool scheduled for auto-recovery; next ensurePool() will wait for old pool destruction.');
        // Destroy the old pool asynchronously after the event handler returns.
        const t = setTimeout(async () => {
            try {
                // If shutdown() ran while this timer was pending it already destroyed
                // the pool, so skip the second destroy to avoid a spurious error.
                if (this.isShuttingDown) return;
                if (deadPool) await deadPool.destroy();
                logger.info('[WorkerPoolManager] Auto-recovery: old pool destroyed.');
            } catch (err) {
                logger.warn('[WorkerPoolManager] Auto-recovery: error destroying old pool:', err);
            } finally {
                // Now nullify the dead pool and clear the flag
                if (this.pool === deadPool) this.pool = null;
                // Clear the cached init promise too — it still resolves to the now
                // DESTROYED pool. Without this, the next ensurePool() skips the
                // (null) fast-path and returns the stale promise, handing callers a
                // dead pool ("Cannot execute a task on destroying pool"). shutdown()
                // already clears it; auto-recovery must as well.
                this.poolInitializationPromise = null;
                this._resetInProgress = false;
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
                const destroyPromise = this.pool.destroy();
                destroyPromise.catch((err: Error) => logger.debug(`[WorkerPoolManager] Background pool destroy rejection: ${err.message}`));
                await Promise.race([
                    destroyPromise,
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
