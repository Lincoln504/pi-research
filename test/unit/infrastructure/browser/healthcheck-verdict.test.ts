/**
 * The health probe's deadline measures execution, and its verdict has exactly one
 * signal — driven through the real runHealthCheck.
 *
 * The probe's deadline used to include queue wait, so during a large search burst it
 * expired without ever reaching a worker and the registry reported
 * "critical component unhealthy mid-run: BrowserRuntime" while the pool was healthily
 * executing that very burst. It fired twice on the night this was measured, bracketing
 * the saturated rounds. Arming the deadline on DISPATCH fixes that, and is the whole
 * fix.
 *
 * Three separate attempts were then made to add a SECOND, wait-phase verdict that would
 * excuse a saturated pool, and all three were wrong. They are recorded here because
 * each reads sensibly and the next reader will otherwise reach for one of them:
 *
 *   1. "did the queue dispatch anything recently" — unreachable. Healthcheck tasks have
 *      strict queue priority, so if a slot frees while the probe waits, the queue
 *      dispatches THIS probe and cancels the wait timer. The timer can only fire in a
 *      window where nothing dispatched at all. It shipped as a message change wearing a
 *      behaviour change's description, and survived because the tests exercised an
 *      extracted predicate rather than runHealthCheck itself.
 *   2. "are the slots occupied" — wrong in the dangerous direction. activeCount rises
 *      before pool.execute, so workers stuck in a browser launch that never finishes are
 *      occupied slots, and the very incident this was written for would have reported
 *      HEALTHY.
 *   3. "has a task completed successfully recently" — unreachable for the same reason as
 *      (1), which is why the test written for it could never be made to pass: a success
 *      frees a slot, a freed slot dispatches this probe, so at expiry the last success
 *      is necessarily older than the entire budget.
 *
 * The general form of the mistake: with strict priority, a probe that waited out its
 * whole budget without being dispatched IS the evidence of a wedge. There is no second
 * signal. The queue's counters remain, but as DIAGNOSIS in the failure message rather
 * than as a verdict, and these tests pin that distinction.
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
import { metrics } from '../../../../src/utils/metrics.ts';

const CFG = { WORKER_THREADS: 1, WORKER_CONCURRENCY: 1 } as any;
const BUDGET = 150; // ms — the probe's whole budget, so the wait verdict is reachable

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('healthcheck-scheduler', stateManager, {} as any);
}

describe('a busy pool does not fail the probe, because the probe outranks its work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolState.workMs = 0;
  });

  it('is dispatched ahead of queued work rather than waiting behind it', async () => {
    // The production shape, and the reason no saturation verdict is needed: the pool is
    // full of the run's own work, and the probe still gets the next slot because
    // healthchecks outrank searches and scrapes. Under the old enqueue-time deadline
    // this same setup expired the probe and reported the pool critically unhealthy.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let keepWorking = true;
    const churn = (async () => {
      while (keepWorking) await queue.enqueue('scrape', async () => { await new Promise(r => setTimeout(r, 20)); return 'ok'; });
    })();
    await new Promise(r => setTimeout(r, 10)); // let it take the only slot

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );

    keepWorking = false;
    await churn;

    // It really ran, rather than being excused: an execution duration was recorded.
    const durations = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_healthcheck_duration_ms');
    expect(durations).toHaveLength(1);
    expect(durations[0]![2]).toEqual({ status: 'success' });
  });

  it('answers UNHEALTHY when the slots are full and nothing ever frees one', async () => {
    // The incident the probe exists for: workers occupied by browser launches that never
    // finish. Nothing completes, so no slot frees, so the probe is never dispatched —
    // and that is the evidence, not a proxy for it.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let release!: () => void;
    const wedged = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await wedged; return 'never'; });
    await new Promise(r => setTimeout(r, 10));

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /could not reach a worker/,
    );

    release();
    await occupying;
  });

  it('names what it saw, so a worker wedge and a queue wedge are told apart', async () => {
    // The failure message is where the queue's counters earn their keep. Slots busy with
    // nothing completing is a worker fault; slots free is a queue fault. Reporting only
    // "timed out" sent readers to the wrong subsystem on the night this was diagnosed.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let release!: () => void;
    const wedged = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await wedged; return 'never'; });
    await new Promise(r => setTimeout(r, 10));

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /1 of 1 slots busy, no task has ever completed successfully/,
    );

    release();
    await occupying;
  });

  it('answers unhealthy when slots are free and the probe still is not dispatched', async () => {
    // A queue that has stopped dispatching is the other fault this probe catches, and it
    // must not be excused as business.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);
    // Stop the queue from dispatching while leaving its slots free — a queue-side wedge,
    // as opposed to a worker-side one. Capacity cannot be zeroed to simulate this:
    // getPriorityQueue() recomputes concurrency from config on every task, so it would be
    // restored before the probe was enqueued.
    queue.process = () => {};

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow(
      /0 of 1 slots busy/,
    );
  });

  it('still fails a probe that reaches a worker and then runs too long', async () => {
    // Once dispatched the deadline measures execution, so a genuinely slow probe fails on
    // its own merits rather than being excused by an idle pool.
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

  it('records the probe wait separately from its execution', async () => {
    // The same split the search and scrape paths use. Folding wait into duration is what
    // produced the 51s-median misdiagnosis on the night this subsystem was rewritten.
    const scheduler = makeScheduler();
    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).resolves.toBeDefined();

    const waits = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_healthcheck_queue_wait_ms');
    expect(waits).toHaveLength(1);
    expect(waits[0]![2]).toEqual({ dispatched: 'yes' });
  });

  it('records the wait of a probe that never reached a worker at all', async () => {
    // The longest waits belong to the probes that fail. Recording this only on success
    // would censor exactly the cases the metric exists to show.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);
    queue.process = () => {};

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).rejects.toThrow();

    const waits = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_healthcheck_queue_wait_ms');
    expect(waits).toHaveLength(1);
    expect(waits[0]![2]).toEqual({ dispatched: 'no' });
    expect(waits[0]![1]).toBeGreaterThanOrEqual(BUDGET - 20);
  });
});
