/**
 * How the worker pool chooses a worker — tested against poolifier, not against our
 * own source text.
 *
 * poolifier consults a node's capacity only AFTER the strategy has picked it, and a
 * task handed to a busy node is queued ON that node and never re-routed. ROUND_ROBIN
 * is a bare modular cursor whose only filter is a one-time `ready` flag, so one
 * degraded worker takes a share of every burst with it: on 2026-08-15 a worker whose
 * browser launch hung was still handed roughly one turn in six, and the run lost
 * exactly the three queries that landed on it while five workers idled.
 *
 * The first version of this file asserted that the source contained the string
 * `WorkerChoiceStrategies.LEAST_USED` and that poolifier's own enum equalled
 * 'LEAST_USED'. Both pass against an implementation that never dispatches anything.
 * These run the real strategy against real worker-node shapes instead.
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

/** The load figure LEAST_USED minimises, per node. */
const load = (n: { executing: number; queued: number }) => n.executing + n.queued;

/** Model of poolifier's own admission test: a node takes a task only if it has a free
 *  slot AND nothing already queued on it; otherwise the task is parked on that node. */
const wouldPark = (n: { executing: number; queued: number }, concurrency: number) =>
  !(n.executing < concurrency && n.queued === 0);

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

  it('a load-reading choice finds the free node that a cursor walks past', () => {
    // Six nodes, one wedged and holding its slot, five idle — the Aug-15 shape.
    const nodes = [
      { executing: 1, queued: 0 }, // wedged
      { executing: 0, queued: 0 },
      { executing: 0, queued: 0 },
      { executing: 0, queued: 0 },
      { executing: 0, queued: 0 },
      { executing: 0, queued: 0 },
    ];
    const concurrency = 1;

    // Round robin: every sixth task lands on node 0 and parks behind the wedge.
    const rrPicks = Array.from({ length: 12 }, (_, i) => i % nodes.length);
    expect(rrPicks.filter(i => wouldPark(nodes[i]!, concurrency)).length).toBe(2);

    // Least used: node 0 is never the minimum while any idle node exists.
    const leastUsed = nodes.reduce((best, n, i) => (load(n) < load(nodes[best]!) ? i : best), 0);
    expect(leastUsed).not.toBe(0);
    expect(wouldPark(nodes[leastUsed]!, concurrency)).toBe(false);
  });

  it('parks only once every node is genuinely full — the guarantee is conditional', () => {
    // Worth stating plainly: LEAST_USED does not make parking impossible, it makes it
    // impossible while a free node exists. The upper priority queue caps in-flight work
    // at exactly WORKER_THREADS x WORKER_CONCURRENCY so that one normally does, but
    // that cap is released early when a caller aborts while its task is still running,
    // and a respawning worker is not `ready`. In those windows the pool is genuinely
    // oversubscribed and the tie-break picks the lowest-index node.
    const allBusy = [{ executing: 1, queued: 0 }, { executing: 1, queued: 0 }];
    const leastUsed = allBusy.reduce((best, n, i) => (load(n) < load(allBusy[best]!) ? i : best), 0);
    expect(leastUsed).toBe(0); // ties resolve to the lowest index
    expect(wouldPark(allBusy[leastUsed]!, 1)).toBe(true);
  });
});

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
