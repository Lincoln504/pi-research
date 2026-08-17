/**
 * How the worker pool is configured to choose a worker, and how that choice is measured.
 *
 * These test the two things this repo actually owns: the options handed to poolifier,
 * and the gauges that would have made the dispatch failure visible. What poolifier then
 * DOES with those options is stated at the foot of this file, along with why it is not
 * covered here and what two previous attempts to cover it got wrong.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerChoiceStrategies } from 'poolifier';

vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn() },
}));

import {
  buildWorkerPoolOptions,
  WorkerPoolManager,
} from '../../../../src/infrastructure/browser/worker-pool-manager.ts';
import { metrics } from '../../../../src/utils/metrics.ts';

describe('worker pool dispatch shape', () => {
  it('is configured with a load-reading strategy and a bounded per-worker queue', () => {
    const opts = buildWorkerPoolOptions({ WORKER_THREADS: 6, WORKER_CONCURRENCY: 1 } as any);
    expect(opts.workerChoiceStrategy).toBe(WorkerChoiceStrategies.LEAST_USED);
    expect(opts.enableTasksQueue).toBe(true);
    expect(opts.tasksQueueOptions?.concurrency).toBe(1);
  });

  it('takes per-worker concurrency from config, so both layers agree on capacity', () => {
    expect(buildWorkerPoolOptions({ WORKER_THREADS: 4, WORKER_CONCURRENCY: 3 } as any)
      .tasksQueueOptions?.concurrency).toBe(3);
  });

  it('caps in-flight work at exactly the pool capacity the options declare', () => {
    // This is the half of the guarantee that IS ours to test, and the half that broke:
    // a load-reading strategy only avoids parking while a free node exists, and what
    // makes one exist is the upper PriorityTaskQueue capping in-flight work at exactly
    // WORKER_THREADS x WORKER_CONCURRENCY. Those two layers reading different numbers
    // is precisely how a task came to be queued on a worker the queue believed free —
    // per-worker concurrency is baked into poolifier at construction while the priority
    // queue recomputes its own capacity on every task.
    for (const [threads, concurrency] of [[6, 1], [4, 3], [1, 1]] as const) {
      const opts = buildWorkerPoolOptions({ WORKER_THREADS: threads, WORKER_CONCURRENCY: concurrency } as any);
      expect(opts.tasksQueueOptions?.concurrency).toBe(concurrency);
      expect(threads * (opts.tasksQueueOptions?.concurrency ?? 0)).toBe(threads * concurrency);
    }
  });
});

/*
 * What is deliberately NOT tested here, so the gap is not mistaken for coverage.
 *
 * The behavioural claim — that LEAST_USED picks a node a round-robin cursor would walk
 * past — is poolifier's, not ours, and poolifier does not export its strategy classes,
 * so it cannot be driven from a unit test without reaching into its internals. Two
 * earlier attempts at covering it anyway were both worse than nothing: the first
 * asserted that our source file CONTAINED the string `WorkerChoiceStrategies.LEAST_USED`
 * (which passes against an implementation that never dispatches), and the second
 * re-implemented poolifier's argmin and admission test in the test body and then
 * asserted its own arithmetic over test-local constants (which passes against any
 * implementation at all, since it never touched src/).
 *
 * The claim itself, for the record: poolifier consults a node's capacity only AFTER the
 * strategy has picked it, and a task handed to a busy node is queued ON that node and
 * never re-routed. ROUND_ROBIN is a bare modular cursor whose only filter is a one-time
 * `ready` flag, so on 2026-08-15 a worker whose browser launch hung was still handed
 * roughly one turn in six, and the run lost exactly the three queries that landed on it
 * while five workers idled.
 */

/**
 * The gauges that make the failure above visible have to describe the pool that
 * exists NOW.
 */
describe('dispatch-health gauges', () => {
  const gauge = (name: string) =>
    vi.mocked(metrics.setGauge).mock.calls.filter(c => c[0] === name).at(-1)?.[1];

  beforeEach(() => vi.clearAllMocks());

  it('reports parked tasks only when a node was idle to take them', () => {
    const mgr = new WorkerPoolManager();
    (mgr as any).pool = { info: { queuedTasks: 4, idleWorkerNodes: 2, stolenTasks: 7 } };

    mgr.recordDispatchHealth();

    expect(gauge('browser_pool_parked_tasks')).toBe(4);
    expect(gauge('browser_pool_queued_tasks')).toBe(4);
    expect(gauge('browser_pool_idle_workers')).toBe(2);
    expect(gauge('browser_pool_stolen_tasks')).toBe(7);
  });

  it('does not call a full pool parked — queueing is correct there', () => {
    const mgr = new WorkerPoolManager();
    (mgr as any).pool = { info: { queuedTasks: 4, idleWorkerNodes: 0, stolenTasks: 0 } };

    mgr.recordDispatchHealth();

    expect(gauge('browser_pool_parked_tasks')).toBe(0);
    expect(gauge('browser_pool_queued_tasks')).toBe(4); // still visible, just not a fault
  });

  it('zeroes the levels when there is no pool, rather than leaving the last reading standing', () => {
    // Returning early held the last live value forever, so a burst that ended with
    // tasks parked left a standing non-zero gauge for a pool that no longer exists —
    // and every later read of it was a report about a dead process.
    const mgr = new WorkerPoolManager();
    (mgr as any).pool = { info: { queuedTasks: 4, idleWorkerNodes: 2, stolenTasks: 7 } };
    mgr.recordDispatchHealth();

    (mgr as any).pool = null;
    mgr.recordDispatchHealth();

    expect(gauge('browser_pool_parked_tasks')).toBe(0);
    expect(gauge('browser_pool_queued_tasks')).toBe(0);
    expect(gauge('browser_pool_idle_workers')).toBe(0);
    // Cumulative, not a level: zeroing it on teardown would read as the stolen-task
    // defect having been fixed.
    expect(gauge('browser_pool_stolen_tasks')).toBe(7);
  });
});
