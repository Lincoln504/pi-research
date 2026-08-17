import { logger } from '../../logger.ts';

export type TaskType = 'search' | 'scrape' | 'healthcheck';

export interface QueuedTask<T> {
    type: TaskType;
    fn: () => Promise<T>;
    resolve: (val: T) => void;
    reject: (err: any) => void;
    signal?: AbortSignal;
}

/**
 * A priority-aware task queue for browser operations.
 * 
 * Ensures that 'search' tasks (used by evaluators and for planning) jump ahead
 * of 'scrape' tasks (heavy data gathering) in the queue.
 * 
 * This helps prevent search starvation when the worker pool is saturated by
 * long-running scrapes.
 */
export class PriorityTaskQueue {
    private searchQueue: QueuedTask<any>[] = [];
    private healthcheckQueue: QueuedTask<any>[] = [];
    private scrapeQueue: QueuedTask<any>[] = [];
    private activeCount = 0;
    private maxTotalConcurrency: number;
    private readonly maxQueueDepth: number;
    private isShutdown = false;
    /** When a task last completed WITHOUT error (epoch ms), or 0 if never. The only
     *  evidence that separates a pool doing heavy work from one that has stopped —
     *  see isSaturated's caller. Failures deliberately do not count: a wedged pool
     *  still turns its slots over as deadlines and death-backstops fire, so slot
     *  churn proves nothing, and neither does dispatch. */
    private lastSuccessAt = 0;

    constructor(maxTotalConcurrency: number, maxQueueDepth = 500) {
        this.maxTotalConcurrency = maxTotalConcurrency;
        this.maxQueueDepth = maxQueueDepth;
    }

    /**
     * Enqueue a task with priority.
     * Searches and healthchecks have high priority.
     */
    enqueue<T>(type: TaskType, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask<T> = { type, fn, resolve, reject, signal };

            if (this.isShutdown) {
                return reject(new Error(`PriorityTaskQueue is shutting down; rejecting ${type} task`));
            }

            if (signal?.aborted) {
                return reject(new Error(`Task ${type} aborted before enqueuing`));
            }

            const totalDepth = this.healthcheckQueue.length + this.searchQueue.length + this.scrapeQueue.length;
            if (totalDepth >= this.maxQueueDepth) {
                return reject(new Error(`PriorityTaskQueue at capacity (${this.maxQueueDepth} tasks). Dropping ${type} task.`));
            }

            let onAbort: (() => void) | undefined;
            if (signal) {
                onAbort = () => {
                    if (this.removeFromQueue(task)) {
                        task.reject(new Error(`Task ${type} aborted while in queue`));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            
            // Wrap resolve/reject to ensure listener cleanup
            const wrappedResolve = (val: T) => {
                if (signal && onAbort) signal.removeEventListener('abort', onAbort);
                resolve(val);
            };
            const wrappedReject = (err: any) => {
                if (signal && onAbort) signal.removeEventListener('abort', onAbort);
                reject(err);
            };

            task.resolve = wrappedResolve;
            task.reject = wrappedReject;

            if (type === 'healthcheck') {
                this.healthcheckQueue.push(task);
            } else if (type === 'search') {
                this.searchQueue.push(task);
            } else {
                this.scrapeQueue.push(task);
            }
            
            logger.debug(`[PriorityQueue] Task enqueued: ${type}. Active: ${this.activeCount}, Capacity: ${this.maxTotalConcurrency}. Queues: H:${this.healthcheckQueue.length} S:${this.searchQueue.length} SC:${this.scrapeQueue.length}`);
            this.process();
        });
    }

    /** Epoch ms of the last task that completed successfully, or 0 if none has. */
    getLastSuccessAt(): number {
        return this.lastSuccessAt;
    }

    /** Tasks currently executing on a worker. */
    getActiveCount(): number {
        return this.activeCount;
    }

    /** How many tasks may execute at once. */
    getConcurrency(): number {
        return this.maxTotalConcurrency;
    }

    /**
     * Is every worker slot occupied?
     *
     * The distinction a health probe needs. A probe that cannot claim a slot has
     * learned nothing on its own — healthcheck tasks have strict queue priority, so
     * the only reason one waits is that no slot came free, and that is equally true
     * of a pool doing heavy honest work and a pool that has stopped. What separates
     * them is whether the slots are occupied by RUNNING tasks (saturated) or sitting
     * idle while the queue fails to dispatch (broken).
     */
    isSaturated(): boolean {
        // Capacity zero is not saturation — it is a queue that can never dispatch.
        // Without this guard `0 >= 0` reports a stopped queue as busy, which is the
        // one verdict a health probe must never reach by accident.
        return this.maxTotalConcurrency > 0 && this.activeCount >= this.maxTotalConcurrency;
    }

    private removeFromQueue(task: QueuedTask<any>): boolean {
        const queues = [this.healthcheckQueue, this.searchQueue, this.scrapeQueue];
        for (const q of queues) {
            const idx = q.indexOf(task);
            if (idx !== -1) {
                q.splice(idx, 1);
                return true;
            }
        }
        return false;
    }

    private process() {
        // Fill available slots
        while (this.activeCount < this.maxTotalConcurrency) {
            let task: QueuedTask<any> | undefined;
            
            if (this.healthcheckQueue.length > 0) {
                task = this.healthcheckQueue.shift();
            } else if (this.searchQueue.length > 0) {
                task = this.searchQueue.shift();
            } else if (this.scrapeQueue.length > 0) {
                task = this.scrapeQueue.shift();
            }

            if (!task) {
                break;
            }

            // If task was aborted while in queue, reject it and continue to the next one
            // without incrementing activeCount or calling runTask.
            if (task.signal?.aborted) {
                task.reject(new Error(`Task ${task.type} aborted before starting`));
                continue;
            }

            this.runTask(task);
        }
    }

    private async runTask(task: QueuedTask<any>) {
        // Double check abortion right before incrementing activeCount (redundant but safe)
        if (task.signal?.aborted) {
            task.reject(new Error(`Task ${task.type} aborted before starting`));
            return;
        }

        this.activeCount++;
        logger.debug(`[PriorityQueue] Starting task: ${task.type}. Active: ${this.activeCount}/${this.maxTotalConcurrency}`);

        // Race the task against caller abort. Without this, an abort while the
        // task is RUNNING is a no-op (the queue-level abort listener only removes
        // queued tasks), so a long task pins its concurrency slot until its own
        // timeout fires — starving every other queued task. We cannot kill the
        // underlying worker job from here (that needs IPC-level cancellation, a
        // separate concern), so the orphaned fn() keeps running until it settles
        // on its own; we swallow its late settlement and free the slot now so the
        // queue can dispatch the next task immediately.
        let onAbort: (() => void) | undefined;

        try {
            // task.fn() is invoked INSIDE the try: a non-async fn that throws
            // synchronously would otherwise escape before the finally that decrements
            // activeCount, permanently inflating the active count (starving the queue
            // by one slot each time) and leaving the caller's enqueue() promise
            // unsettled. Every fn today is async, so this is a latent shape defect
            // rather than a live one — but the correct placement costs nothing.
            const fnPromise = task.fn();
            // Prevent an unhandled rejection if abort wins the race and fn() rejects later.
            fnPromise.catch(() => { /* handled via the race below or abandoned on abort */ });

            let result: any;
            if (task.signal) {
                const abortPromise = new Promise<never>((_, rej) => {
                    onAbort = () => rej(new Error(`Task ${task.type} aborted while running`));
                    task.signal!.addEventListener('abort', onAbort, { once: true });
                });
                result = await Promise.race([fnPromise, abortPromise]);
            } else {
                result = await fnPromise;
            }
            this.lastSuccessAt = Date.now();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            if (task.signal && onAbort) task.signal.removeEventListener('abort', onAbort);
            this.activeCount--;
            logger.debug(`[PriorityQueue] Task finished: ${task.type}. Active: ${this.activeCount}/${this.maxTotalConcurrency}`);
            // Check for more tasks on next tick
            process.nextTick(() => this.process());
        }
    }
    
    /**
     * Update the maximum concurrency limit (e.g. if config changes).
     */
    updateConcurrency(maxTotalConcurrency: number) {
        // Called on a path that runs per task, and the value almost never changes: this
        // logged "Concurrency updated to 6" 709 times in one day, always to the value it
        // already had. Log real changes only — a line that fires constantly and says
        // nothing is what a reader learns to skip past, including on the day it matters.
        // process() still runs unconditionally: it is idempotent, and a raise that
        // arrived while the queue was full must be free to dispatch immediately.
        if (maxTotalConcurrency !== this.maxTotalConcurrency) {
            logger.debug(`[PriorityQueue] Concurrency changed ${this.maxTotalConcurrency} -> ${maxTotalConcurrency}`);
        }
        this.maxTotalConcurrency = maxTotalConcurrency;
        this.process();
    }

    /**
     * FIX (#18): Shut down the queue, rejecting all pending tasks.
     * In-progress tasks are allowed to complete. This prevents the queue from
     * holding unsettled promises that would hang the calling orchestrator.
     */
    shutdown(): void {
        // Latch shutdown so any enqueue() racing with (or following) teardown is
        // rejected instead of landing in a just-cleared queue and dispatching onto a
        // pool that is mid-destroy.
        this.isShutdown = true;
        const error = new Error('PriorityTaskQueue is shutting down');
        for (const task of this.healthcheckQueue) {
            task.reject(error);
        }
        for (const task of this.searchQueue) {
            task.reject(error);
        }
        for (const task of this.scrapeQueue) {
            task.reject(error);
        }
        this.healthcheckQueue.length = 0;
        this.searchQueue.length = 0;
        this.scrapeQueue.length = 0;
        logger.debug(`[PriorityQueue] Shutdown complete. Active tasks: ${this.activeCount}`);
    }

    /**
     * Get current status for metrics or logging.
     */
    getStats() {
        return {
            activeCount: this.activeCount,
            searchQueueDepth: this.searchQueue.length,
            scrapeQueueDepth: this.scrapeQueue.length,
            healthcheckQueueDepth: this.healthcheckQueue.length,
            capacity: this.maxTotalConcurrency
        };
    }
}
