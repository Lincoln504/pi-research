/**
 * A busy pool is not a broken pool — driven through the real runHealthCheck.
 *
 * The probe's deadline used to include queue wait, so during a large search burst it
 * expired without ever reaching a worker and the registry reported
 * "critical component unhealthy mid-run: BrowserRuntime" while the pool was
 * healthily executing that very burst. It fired twice on the night this was
 * measured, bracketing the saturated rounds.
 *
 * The first attempt at a fix asked the queue when it had last dispatched anything.
 * That reads sensibly and is unreachable: healthcheck tasks have strict queue
 * priority, so if a slot frees while the probe waits, the queue dispatches THIS
 * probe and cancels the wait timer. The timer can therefore only fire in a window
 * where nothing dispatched at all — making "dispatched recently" false by
 * construction and every saturated pool a wedged one. It shipped as a message
 * change wearing a behaviour change's description, and it survived because the
 * tests exercised the extracted predicate rather than runHealthCheck itself.
 *
 * These tests drive the real method against a real PriorityTaskQueue, with the
 * budget shortened so the verdict is reachable at all. Occupancy is the signal:
 * full slots mean workers are executing tasks bounded by their own dispatch-armed
 * deadlines, so the probe's turn is coming; idle slots with an undispatched
 * priority probe mean the queue itself has stopped.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/utils/error-tracker.ts', () => ({ errorTracker: { trackError: vi.fn() } }));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn() },
}));

const poolState = vi.hoisted(() => ({ workMs: 0 }));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    ensurePool: vi.fn(async () => ({
      execute: vi.fn(async () => {
        await new Promise(r => setTimeout(r, poolState.workMs));
        return { success: true };
      }),
    })),
    decayConsecutiveErrors: vi.fn(),
  })),
}));

import { BrowserTaskScheduler } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';

const CFG = { WORKER_THREADS: 1, WORKER_CONCURRENCY: 1 } as any;
const BUDGET = 150; // ms — the probe's whole budget, so the verdict is reachable

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('healthcheck-scheduler', stateManager, {} as any);
}

describe('healthcheck distinguishes a saturated pool from a wedged one', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolState.workMs = 0;
  });

  it('answers healthy when every slot is busy and the probe cannot get one', async () => {
    // The exact production shape: the pool is full of the run's own work, which
    // outlasts the probe's budget. The probe never reaches a worker.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await held; return 'held'; });
    await new Promise(r => setTimeout(r, 10)); // let it take the only slot

    const verdict = await scheduler.runHealthCheck(CFG, undefined, BUDGET);
    expect(verdict).toEqual(expect.objectContaining({ success: true }));

    release();
    await occupying;
  });

  it('answers unhealthy when slots are free and the probe still is not dispatched', async () => {
    // A queue that has stopped dispatching is the fault this probe exists to catch,
    // and it must not be excused as business.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);
    // Stop the queue from dispatching while leaving its slots free — the shape of a
    // wedge, as opposed to the shape of a busy pool. Capacity cannot be zeroed to
    // simulate this: getPriorityQueue() recomputes concurrency from config on every
    // task, so it would be restored before the probe was enqueued.
    queue.process = () => {};

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /queue is not dispatching/,
    );
  });

  it('still fails a probe that reaches a worker and then runs too long', async () => {
    // Once dispatched the deadline measures execution, so a genuinely slow probe
    // fails on its own merits rather than being excused by an idle pool.
    poolState.workMs = 600; // > BUDGET
    const scheduler = makeScheduler();

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(/timed out after/);
  });

  it('succeeds normally when a worker is available', async () => {
    const scheduler = makeScheduler();
    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  it('reports occupancy from the queue, so saturation and a wedge are distinguishable at all', async () => {
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    expect(queue.isSaturated()).toBe(false);
    expect(queue.getConcurrency()).toBe(1);

    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await held; return 'held'; });
    await new Promise(r => setTimeout(r, 10));

    expect(queue.getActiveCount()).toBe(1);
    expect(queue.isSaturated()).toBe(true);

    release();
    await occupying;
    expect(queue.isSaturated()).toBe(false);
  });

  it('does not read a zero-capacity queue as busy', async () => {
    // `0 >= 0` is true, so without an explicit guard a queue that can never dispatch
    // anything reports as fully occupied — and a health probe would excuse the one
    // state it exists to catch.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    queue.updateConcurrency(0);
    expect(queue.getActiveCount()).toBe(0);
    expect(queue.isSaturated()).toBe(false);
  });
});
