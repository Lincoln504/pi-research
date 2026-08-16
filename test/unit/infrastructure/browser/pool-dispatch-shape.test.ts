/**
 * How the worker pool chooses a worker, and why it is not a free choice.
 *
 * poolifier consults a node's capacity only AFTER the strategy has picked it, and a
 * task handed to a busy node is queued ON that node and never re-routed. ROUND_ROBIN
 * is a bare modular cursor whose only filter is a one-time `ready` flag, so it cannot
 * see load: one degraded worker takes a share of every burst down with it. Measured
 * on 2026-08-15 — a worker whose browser launch hung was still handed roughly one
 * turn in six, and the run lost exactly the three queries that landed on it, while
 * five workers idled and the shared queue stood empty.
 *
 * LEAST_USED minimises executing + queued. Paired with the PriorityTaskQueue's cap of
 * WORKER_THREADS x WORKER_CONCURRENCY — the pool's exact total capacity — there is
 * always a node with a free slot and an empty queue at dispatch, so nothing is ever
 * parked. That guarantee rests on the two capacities agreeing, which is why the pool
 * must be rebuilt when either input changes.
 */

import { describe, it, expect } from 'vitest';
import { WorkerChoiceStrategies } from 'poolifier';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/infrastructure/browser/worker-pool-manager.ts'),
  'utf-8',
);

describe('worker pool dispatch shape', () => {
  it('chooses workers by load, not by a blind cursor', () => {
    expect(SOURCE).toContain('workerChoiceStrategy: WorkerChoiceStrategies.LEAST_USED');
    expect(SOURCE).not.toContain('workerChoiceStrategy: WorkerChoiceStrategies.ROUND_ROBIN');
  });

  it('the strategy it uses exists in the installed poolifier', () => {
    // A typo here would fall back to poolifier's default silently rather than fail.
    expect(WorkerChoiceStrategies.LEAST_USED).toBe('LEAST_USED');
  });

  it('rebuilds the pool when EITHER input to its capacity changes', () => {
    // Per-worker concurrency is baked into tasksQueueOptions at construction and
    // cannot be changed afterwards, while the PriorityTaskQueue recomputes its own
    // capacity from the same two values on every task. Gating the rebuild on worker
    // count alone let the two layers disagree — and the no-parking guarantee above
    // holds only while they agree.
    expect(SOURCE).toContain('this.currentWorkerConcurrency !== workerConcurrency');
    expect(SOURCE).toContain('this.currentWorkerConcurrency = workerConcurrency');
  });

  it('records the number that should always be zero', () => {
    // Tasks queued on a node while another node is idle. This failure mode was
    // invisible to every metric and log line for the life of the project; poolifier
    // computed it all along on pool.info and nothing read it.
    expect(SOURCE).toContain('browser_pool_parked_tasks');
    expect(SOURCE).toContain('browser_pool_stolen_tasks');
  });
});
