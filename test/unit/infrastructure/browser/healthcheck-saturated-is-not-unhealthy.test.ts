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
 * The second attempt asked whether the slots were occupied. That fails in the
 * opposite and worse direction: activeCount rises before pool.execute and falls when
 * it settles, so workers stuck in a browser launch that never finishes are occupied
 * slots — and the very incident this was written for would have reported HEALTHY.
 *
 * Slot churn is no better, since a wedged pool still turns slots over as deadlines
 * and death-backstops fire. The signal has to be a SUCCESSFUL completion: a busy
 * pool produces them continuously, a stopped one produces none. These tests drive
 * the real method against a real PriorityTaskQueue, with the probe's budget
 * shortened so the verdict is reachable at all.
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

  it('answers healthy when the pool is full and still completing work', async () => {
    // The production shape: the pool is full of the run's own work, which outlasts
    // the probe's budget, and that work is succeeding.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    // A real busy pool completes work continuously while the probe waits — that
    // stream of successes is the evidence. Occupy the slot with short tasks back to
    // back rather than one long one, which is what a search burst actually looks
    // like, and what makes the probe wait without the pool being broken.
    let keepWorking = true;
    const churn = (async () => {
      while (keepWorking) await queue.enqueue('scrape', async () => { await new Promise(r => setTimeout(r, 20)); return 'ok'; });
    })();
    await new Promise(r => setTimeout(r, 10)); // let it take the only slot

    const verdict = await scheduler.runHealthCheck(CFG, undefined, BUDGET);
    expect(verdict).toEqual(expect.objectContaining({ success: true }));

    keepWorking = false;
    await churn;
  });

  it('answers UNHEALTHY when the slots are full but nothing is completing', async () => {
    // The incident this was written for: workers occupied by browser launches that
    // never finish. Occupancy alone reports that as busy — activeCount rises before
    // the work starts — so the first version of this fix would have called a dead
    // pool healthy. Only a successful completion distinguishes them.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let release!: () => void;
    const wedged = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await wedged; return 'never'; });
    await new Promise(r => setTimeout(r, 10));

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /no task has ever completed successfully/,
    );

    release();
    await occupying;
  });

  it('does not accept slot churn as evidence — a failing task is not a working pool', async () => {
    // A wedged pool still turns its slots over as deadlines and death-backstops fire.
    // Counting that as progress would excuse exactly the state this probe exists for.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    await queue.enqueue('scrape', async () => { throw new Error('worker died'); }).catch(() => {});

    let release!: () => void;
    const wedged = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await wedged; return 'never'; });
    await new Promise(r => setTimeout(r, 10));

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(/completed successfully/);

    release();
    await occupying;
  });

  it('answers unhealthy when slots are free and the probe still is not dispatched', async () => {
    // A queue that has stopped dispatching is the fault this probe exists to catch,
    // and it must not be excused as business.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);
    // Stop the queue from dispatching while leaving its slots free — a queue-side
    // wedge, as opposed to a worker-side one. Capacity cannot be zeroed to simulate
    // this: getPriorityQueue() recomputes concurrency from config on every task, so
    // it would be restored before the probe was enqueued.
    queue.process = () => {};

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /could not reach a worker/,
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
