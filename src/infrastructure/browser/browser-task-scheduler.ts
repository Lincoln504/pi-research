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
import type { IScheduler, TaskDispatchListener } from '../../core/interfaces/scheduler-interfaces.ts';
import { cleanupOrphanedCamoufoxProcesses, getBrowserPidsForWorkers, killBrowserProcesses } from './browser-cleanup.ts';
import { raceWithDeadline } from '../../utils/safe-unref.ts';
import { PriorityTaskQueue } from './priority-task-queue.ts';

/**
 * Grace added to the worker's own task budget before the dead-worker backstop
 * fires, so a live worker's more informative timeout always answers first.
 */
export const WORKER_DEATH_BACKSTOP_GRACE_MS = 5000;

/**
 * Execute a pool task with a dead-worker backstop.
 *
 * poolifier (measured on 5.3.2) never settles an in-flight execute() whose worker
 * dies — not when the worker exits, not when a replacement is respawned, not even
 * when the pool is destroyed. The worker enforces taskTimeoutMs on itself, but only
 * while it is alive; an OOM-killed worker leaves the promise pending forever, and
 * with it the PriorityTaskQueue concurrency slot the dispatched closure holds. Each
 * such death would permanently shrink the queue until the leader serves nothing but
 * timeouts.
 *
 * The backstop timer is created inside the dispatched closure, so it shares no
 * lifetime with the caller's outer race — whose `finally` clearing a shared timer
 * is exactly how a QUEUED task once lost its guard. Armed at dispatch, it fires
 * only when nothing is left to answer; its rejection frees the queue slot (the
 * caller has already been answered by the outer race).
 */
export async function executePoolTaskWithDeathBackstop<T>(
    execute: () => Promise<T>,
    taskTimeoutMs: number,
    label: string,
): Promise<T> {
    const backstopMs = taskTimeoutMs + WORKER_DEATH_BACKSTOP_GRACE_MS;
    let backstopId: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            execute(),
            new Promise<never>((_, reject) => {
                backstopId = setTimeout(
                    () => reject(new Error(`${label} task unanswered after ${backstopMs}ms — worker likely died mid-task`)),
                    backstopMs,
                );
                if (backstopId.unref) backstopId.unref();
            }),
        ]);
    } finally {
        if (backstopId) clearTimeout(backstopId);
    }
}

/**
 * Browser task scheduler - manages the worker pool and executes tasks.
 * Only the leader process has an instance of this scheduler.
 */
/**
 * How long a task actually RAN, given when it was dispatched and when it was
 * submitted.
 *
 * Duration used to be `now - submittedAt`, which folds queue wait into the work.
 * That is the number `Search completed ... in Nms` prints and the number
 * `browser_search_duration_ms` records, so it is what every latency investigation
 * reads — and during a saturated burst it reported a 51s median against a true
 * 5.8s execution median. A whole evening went into explaining a slowdown that had
 * not happened. Moving the deadline off queue wait while leaving the measurement
 * on it would have preserved exactly that misdiagnosis.
 *
 * A task that never reached a worker has no execution time; report its full
 * elapsed span rather than zero, so a timeout is not silently recorded as instant.
 */
export function executionMs(dispatchedAt: number, submittedAt: number, now: number = Date.now()): number {
    return dispatchedAt > 0 ? now - dispatchedAt : now - submittedAt;
}

/** How long a task sat in the queue before a worker took it. Zero if never dispatched. */
export function queueWaitMs(dispatchedAt: number, submittedAt: number): number {
    return dispatchedAt > 0 ? dispatchedAt - submittedAt : 0;
}

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
                        await this.shutdown('leadership-lost');
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
                // Sampled on the leadership tick rather than per task: this is a
                // distribution property, not a per-task one, and it should read zero.
                poolManager.recordDispatchHealth();
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
            this.shutdown('idle-timeout').catch(err => logger.warn('[Scheduler] Idle-timeout shutdown failed (non-fatal):', err));
        }, this.IDLE_TIMEOUT_MS);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    public resetIdleTimerOnActivity(): void {
        this.resetIdleTimer();
    }

    async startServer(): Promise<number> {
        this.server = new BrowserServer({
            // The per-request signal aborts when the follower's socket closes
            // before completion, so the leader-side task releases its queue
            // claim (abort-while-queued/running is the PriorityTaskQueue's own
            // pinned semantics) instead of holding the slot to full timeout.
            // Healthcheck mirrors search/scrape here even though its one current
            // production caller (src/healthcheck/index.ts) never passes a signal —
            // the wiring must not silently drop one the moment a caller does.
            onSearch: (q, signal) => this.runSearch(q, undefined, signal),
            onScrape: (u, signal) => this.runScrape(u, undefined, signal),
            onHealthCheck: (signal) => this.runHealthCheck(undefined, signal),
        });
        // FIX (#21): Expose auth secret to child processes via env
        process.env['PI_BROWSER_AUTH_SECRET'] = getBrowserServerAuthSecret();
        return this.server.start();
    }

    async runSearch(query: string, config?: Config, signal?: AbortSignal, onDispatch?: TaskDispatchListener): Promise<SearchResult[]> {
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

        // The deadline measures EXECUTION, not queue wait: the timer is armed by
        // `startDeadline()` from inside the enqueued callback, i.e. once the queue has
        // actually dispatched this task to a worker.
        //
        // It used to be armed here, before enqueuing, so a saturated queue burned a task's
        // entire budget waiting for a slot and it aborted having done no work at all. That
        // made the number of tasks a burst could complete `capacity x (budget / latency)`
        // rather than the number submitted — measured on a live run, 78 of 100 searches
        // aborted at the deadline without ever running. A queue is supposed to absorb
        // volume by making work wait, not by killing whatever it could not reach in time.
        // Waiting is now bounded by the caller's signal and the run-level timeouts; a task
        // that does get dispatched always gets its full budget.
        // `dispatchedAt` is the same instant, kept for MEASUREMENT rather than for the
        // deadline. Reporting `Date.now() - startTime` as the search's duration charged
        // queue wait to the work, and that number is what every latency analysis reads:
        // on the night this was diagnosed it reported a 51s median against a true 5.8s
        // execution median, and invented an eightfold latency regression that never
        // happened. Moving the deadline off queue wait without moving the measurement
        // would have left the misdiagnosis in place while claiming to have fixed it.
        let timeoutId: NodeJS.Timeout | undefined;
        let dispatchedAt = 0;
        let startDeadline: () => void = () => {};
        const timeoutPromise = new Promise<never>((_, reject) => {
            startDeadline = () => {
                dispatchedAt = Date.now();
                timeoutId = setTimeout(() => {
                    reject(new Error(`Search task timed out after ${timeoutMs}ms. query="${query}"`));
                }, timeoutMs);
                if (timeoutId.unref) timeoutId.unref();
            };
        });

        logger.debug(`[BrowserTaskScheduler] Executing search: "${query}" (Timeout: ${timeoutMs}ms)`);
        let result: any;
        // Settling the outer race must also release the task's queue claim: a task
        // still QUEUED when the caller is answered is cancelled before it consumes
        // a slot, and a RUNNING one frees its slot instead of keeping it (plus a
        // fresh worker budget) for a result nobody will consume. The abort-while-
        // queued/running semantics are the queue's own, pinned by its tests.
        const settled = new AbortController();
        const queueSignal = signal ? AbortSignal.any([signal, settled.signal]) : settled.signal;
        try {
            const queue = this.getPriorityQueue(config);
            // Race the enqueue call against the timeoutPromise.
            // This ensures that even if the queue is saturated, we won't hang forever.
            result = await Promise.race([
                queue.enqueue('search', async () => {
                    startDeadline();
                    // Same instant, for the same reason, one layer up: whoever called us
                    // arms their own guard here instead of at call time. A listener that
                    // throws must not take the task down with it.
                    try { onDispatch?.(); } catch { /* caller's guard, caller's problem */ }
                    // The shared timeoutPromise is deliberately NOT raced in here (its timer
                    // dies with the outer race); the backstop below carries its own timer, so
                    // a QUEUED task can never be dispatched against a disarmed guard, and a
                    // worker dying mid-task cannot pin the queue slot forever.
                    return await executePoolTaskWithDeathBackstop(
                        () => pool.execute({ type: 'search', query, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                        timeoutMs,
                        'Search',
                    );
                }, queueSignal),
                timeoutPromise
            ]);
            logger.debug(`[BrowserTaskScheduler] Search completed: "${query}" in ${executionMs(dispatchedAt, startTime)}ms (queued ${queueWaitMs(dispatchedAt, startTime)}ms)`);
        } catch (error) {
            // A pool-shutdown/destroy error means the run is being torn down (quit/SIGTERM
            // mid-search-burst): the task never ran because dispose() destroyed the pool.
            // That is expected teardown, not a fault — log at DEBUG and don't count it toward
            // the error metric/tracker, so a normal quit-mid-run doesn't inflate ERROR counts.
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Search abandoned during shutdown: "${query}"`);
                throw error;
            }
            // The caller's own signal aborting (follower socket closed / research run
            // cancelled) is what PriorityTaskQueue's abort-while-queued/running
            // rejection above reports. This is routine, expected cancellation, not a
            // fault — cancelling a run routinely cancels its in-flight browser tasks,
            // so this fires often. Checking the signal directly (rather than matching
            // the queue's rejection text) mirrors how BrowserServer's own catch block
            // and task-execution-service.ts already classify this. Demote to DEBUG so
            // it doesn't inflate ERROR counts / browser_search_errors_total.
            if (signal?.aborted) {
                logger.debug(`[BrowserTaskScheduler] Search cancelled by caller: "${query}"`);
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
            settled.abort();
        }

        const duration = executionMs(dispatchedAt, startTime);
        metrics.observe('browser_search_queue_wait_ms', queueWaitMs(dispatchedAt, startTime));
        // In-band worker error checked FIRST: a task the worker reports as failed
        // must count only as an error. Recording success unconditionally before
        // this check double-counted every worker-reported failure as
        // success+error, so dashboards read healthy through a full outage.
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
        metrics.observe('browser_search_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_search_requests_total', 1, { status: 'success' });
        return result.results;
    }

    async runScrape(url: string, config?: Config, signal?: AbortSignal, onDispatch?: TaskDispatchListener): Promise<ScrapeResult> {
        if (this.isShuttingDown) throw new Error('Worker pool is shutting down');
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        // Task timeout = the scrape nav budget (SCRAPE_TIMEOUT_MS) + the queue-wait/overhead
        // margin (BROWSER_TASK_TIMEOUT_MS), mirroring the search path so both stay coherent.
        const cfg = config || getConfig();
        const isMocking = process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
        const timeoutMs = cfg.SCRAPE_TIMEOUT_MS + (isMocking ? 5000 : cfg.BROWSER_TASK_TIMEOUT_MS);

        // Armed on dispatch, not on enqueue — see runSearch for why.
        // See runSearch: dispatch time is tracked for measurement, not for the deadline.
        let timeoutId: NodeJS.Timeout | undefined;
        let dispatchedAt = 0;
        let startDeadline: () => void = () => {};
        const timeoutPromise = new Promise<never>((_, reject) => {
            startDeadline = () => {
                dispatchedAt = Date.now();
                timeoutId = setTimeout(() => {
                    reject(new Error(`Scrape task timed out after ${timeoutMs}ms. url="${url}"`));
                }, timeoutMs);
                if (timeoutId.unref) timeoutId.unref();
            };
        });

        let result: any;
        // See runSearch: outer settle releases the queue claim; the backstop bounds
        // a dead worker's never-settling execute().
        const settled = new AbortController();
        const queueSignal = signal ? AbortSignal.any([signal, settled.signal]) : settled.signal;
        try {
            const queue = this.getPriorityQueue(config);
            result = await Promise.race([
                queue.enqueue('scrape', async () => {
                    startDeadline();
                    // See runSearch: the caller's guard is armed on dispatch too.
                    try { onDispatch?.(); } catch { /* caller's guard, caller's problem */ }
                    return await executePoolTaskWithDeathBackstop(
                        () => pool.execute({ type: 'scrape', url, queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                        timeoutMs,
                        'Scrape',
                    );
                }, queueSignal),
                timeoutPromise
            ]);
        } catch (error) {
            // Pool-shutdown/destroy mid-scrape is expected teardown (quit/SIGTERM), not a
            // fault — demote to DEBUG and don't inflate the error metric/tracker (mirrors runSearch).
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Scrape abandoned during shutdown: "${url}"`);
                throw error;
            }
            // See runSearch: the caller's own signal aborting is routine cancellation
            // (follower disconnect / run cancelled), not a fault — demote to DEBUG.
            if (signal?.aborted) {
                logger.debug(`[BrowserTaskScheduler] Scrape cancelled by caller: "${url}"`);
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
            settled.abort();
        }

        const duration = executionMs(dispatchedAt, startTime);
        metrics.observe('browser_scrape_queue_wait_ms', queueWaitMs(dispatchedAt, startTime));
        // In-band error first — success-side recording must not precede it (see runSearch).
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
        metrics.observe('browser_scrape_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_scrape_requests_total', 1, { status: 'success' });
        return result;
    }

    async runHealthCheck(config?: Config, signal?: AbortSignal, budgetOverrideMs?: number): Promise<{ success: boolean }> {
        if (this.isShuttingDown) throw new Error('Worker pool is shutting down');
        this.resetIdleTimer();
        const pool = await (await this.getWorkerPoolManager()).ensurePool(config);
        const startTime = Date.now();
        const isMocking = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' || process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
        // The one task budget that is not config-derived. `budgetOverrideMs` exists so
        // the saturated-vs-wedged verdict below is reachable from a test: at 105s it is
        // not, which is exactly how a previous version of that verdict shipped
        // unreachable and stayed that way.
        const timeoutMs = budgetOverrideMs ?? (45000 + 60000) / (isMocking ? 4 : 1);

        // A probe that never got a worker used to fail as "timed out (including queue
        // wait)", and the registry reported BrowserRuntime CRITICALLY UNHEALTHY —
        // during a burst in which the pool was healthily executing the run's own
        // searches. Twice on the night this was measured.
        //
        // The verdict rests on whether the SLOTS ARE OCCUPIED, and it has to. An
        // earlier version of this asked the queue when it last dispatched anything,
        // which reads sensibly and is unreachable: healthcheck tasks have strict queue
        // priority, so if any slot frees while this probe waits, the queue dispatches
        // THIS probe — clearing the timer below. The wait timer can therefore only fire
        // in a window where nothing was dispatched at all, making "dispatched recently"
        // false by construction and every saturated pool a wedged one. The bug survived
        // its own fix because no test drove a saturated pool through runHealthCheck.
        //
        // Occupancy has no such circularity: full slots mean workers are executing
        // tasks, each bounded by its own dispatch-armed deadline, so the probe's turn
        // is coming. Idle slots and an undispatched priority probe mean the queue
        // itself has stopped, which is the fault this exists to catch.
        //
        // Once dispatched, the deadline measures execution alone (armed below, like
        // runSearch/runScrape), so a slow probe still fails on its own merits.
        let timeoutId: NodeJS.Timeout | undefined;
        let dispatched = false;
        let hcDispatchedAt = 0;
        let startDeadline: () => void = () => {};
        // Captured BEFORE the timer can run. Resolving the queue inside the callback
        // would call getPriorityQueue() on a scheduler that may have shut down in the
        // meantime, which builds a FRESH queue on the dead instance — undoing the
        // isShutdown latch that exists to reject enqueues racing teardown, and
        // reporting a routine shutdown as a wedge because a new queue has dispatched
        // nothing.
        const healthQueue = this.getPriorityQueue(config);
        const timeoutPromise = new Promise<{ success: boolean } | never>((resolve, reject) => {
            const onWaitExpired = () => {
                if (dispatched) return;
                if (healthQueue.isSaturated()) {
                    logger.debug(`[BrowserTaskScheduler] Healthcheck could not claim a worker within ${timeoutMs}ms; all ${healthQueue.getConcurrency()} slots are executing tasks — pool saturated, not wedged.`);
                    resolve({ success: true });
                    return;
                }
                reject(new Error(`Health check could not reach a worker within ${timeoutMs}ms while only ${healthQueue.getActiveCount()} of ${healthQueue.getConcurrency()} slots were busy — the queue is not dispatching.`));
            };
            timeoutId = setTimeout(onWaitExpired, timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
            startDeadline = () => {
                dispatched = true;
                hcDispatchedAt = Date.now();
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms.`)), timeoutMs);
                if (timeoutId.unref) timeoutId.unref();
            };
        });

        let result: { success: boolean; error?: string };
        // See runSearch: outer settle releases the queue claim; the backstop bounds
        // a dead worker's never-settling execute().
        const settled = new AbortController();
        const queueSignal = signal ? AbortSignal.any([signal, settled.signal]) : settled.signal;
        try {
            // Same instance the wait-phase verdict reads, so the two cannot disagree
            // about which queue this probe is waiting on.
            result = await Promise.race([
                healthQueue.enqueue('healthcheck', async () => {
                    startDeadline();
                    return await executePoolTaskWithDeathBackstop(() => {
                        const execPromise = pool.execute({ type: 'healthcheck', queuedAt: startTime, taskTimeoutMs: timeoutMs });
                        execPromise.catch((err: Error) => logger.debug(`[BrowserTaskScheduler] Background healthcheck task rejection: ${err.message}`));
                        return execPromise;
                    }, timeoutMs, 'Healthcheck');
                }, queueSignal),
                timeoutPromise
            ]) as { success: boolean; error?: string };
        } catch (error) {
            // Pool-shutdown/destroy mid-healthcheck is expected teardown, not a fault —
            // demote to DEBUG and don't inflate the error metric/tracker (mirrors runSearch).
            if (isPoolShutdownError(error)) {
                logger.debug(`[BrowserTaskScheduler] Healthcheck abandoned during shutdown`);
                throw error;
            }
            // See runSearch: the caller's own signal aborting is routine cancellation,
            // not a fault — demote to DEBUG. Reachable now that startServer() forwards
            // a signal into onHealthCheck (see BrowserServer's onHealthCheck wiring).
            if (signal?.aborted) {
                logger.debug(`[BrowserTaskScheduler] Healthcheck cancelled by caller`);
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
            settled.abort();
        }

        const duration = executionMs(hcDispatchedAt, startTime);
        // In-band error first — success-side recording must not precede it (see
        // runSearch). This path additionally owns the browser_pool_health gauge:
        // setting it to 1 before the check flickered the pool healthy on every
        // failed probe during an outage.
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
        metrics.observe('browser_healthcheck_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_healthcheck_requests_total', 1, { status: 'success' });
        metrics.setGauge('browser_pool_health', 1);
        logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
        return result;
    }

    /**
     * @param reason why the pool is going away. Reported verbatim to clients in the
     *   drain 503, so a lost election, an idle timeout and a process shutdown are
     *   distinguishable in a client-side log rather than all reading as one.
     */
    async shutdown(reason = 'shutting-down') {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        // Start draining before any of the teardown below. Clearing state and
        // stopping the pool involves awaits, and until the listener actually
        // closes a connected client would otherwise keep issuing requests against
        // a pool that is already going away — the leadership-loss case this
        // guards. Draining first turns those into an immediate 503 so the client
        // re-elects at once instead of waiting for a reset.
        if (this.server?.hasActiveClients()) {
            logger.log(`[Scheduler] Draining ${this.server.getConnectionCount()} client connection(s) before shutdown (${reason}).`);
        }
        this.server?.beginDrain(reason);

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
            try {
                const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER, undefined, this.container);
                const currentScheduler = schedulerService.getSchedulerInstance();
                if (currentScheduler && 'schedulerId' in currentScheduler && currentScheduler.schedulerId === this.schedulerId) {
                    schedulerService.setSchedulerInstance(null);
                    schedulerService.setSchedulerVersion(null);
                    schedulerService.setSchedulerInitializationPromise(null);
                }
            } catch (err) {
                // Disposal can begin between the isDisposing check above and the
                // getService call. isShuttingDown is already latched true, so a
                // throw here would abort shutdown permanently — drain, state-clear,
                // server-stop and pool teardown would all be skipped. The reference
                // being unclearable is the same moot case the guard above covers.
                logger.debug('[Scheduler] Could not clear scheduler service reference during shutdown:', err);
            }
        }

        let serverInfo: { port: number; pid: number; schedulerId?: string } | null = null;
        try {
            serverInfo = await this.stateManager.getBrowserServer();
        } catch (err) {
            logger.warn('[Scheduler] Could not read browser server state during shutdown:', err);
        }
        if (serverInfo?.pid === process.pid && serverInfo?.schedulerId === this.schedulerId) {
            // CAS: this belief-check (pid + schedulerId match) happens outside any
            // lock, so pass it as `expected` rather than relying on it as an
            // assumption — if a successor claimed the slot between the read above
            // and this clear, the mismatch makes the clear a no-op instead of
            // deregistering the new owner.
            await this.stateManager.clearBrowserServer({ pid: process.pid, schedulerId: this.schedulerId }).catch((err) => {
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
