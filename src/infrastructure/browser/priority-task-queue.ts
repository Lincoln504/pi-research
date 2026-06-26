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
        try {
            const result = await task.fn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
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
        this.maxTotalConcurrency = maxTotalConcurrency;
        logger.debug(`[PriorityQueue] Concurrency updated to ${maxTotalConcurrency}`);
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
