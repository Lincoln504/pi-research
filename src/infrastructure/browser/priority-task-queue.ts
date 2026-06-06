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

    constructor(maxTotalConcurrency: number) {
        this.maxTotalConcurrency = maxTotalConcurrency;
    }

    /**
     * Enqueue a task with priority.
     * Searches and healthchecks have high priority.
     */
    enqueue<T>(type: TaskType, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask<T> = { type, fn, resolve, reject, signal };

            if (signal?.aborted) {
                return reject(new Error(`Task ${type} aborted before enqueuing`));
            }

            if (signal) {
                const onAbort = () => {
                    if (this.removeFromQueue(task)) {
                        reject(new Error(`Task ${type} aborted while in queue`));
                    }
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
            
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

            this.runTask(task);
        }
    }

    private async runTask(task: QueuedTask<any>) {
        if (task.signal?.aborted) {
            return;
        }
        
        this.activeCount++;
        try {
            const result = await task.fn();
            task.resolve(result);
        } catch (err) {
            task.reject(err);
        } finally {
            this.activeCount--;
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
