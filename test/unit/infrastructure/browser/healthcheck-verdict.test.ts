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
// Spread the real module rather than replacing it: the busy-pool tolerance gate this
// file pins lives behind src/healthcheck/index.ts, whose registry reads ServiceLifecycle
// from here at class-field-initializer time. A replacement mock leaves it undefined and
// the import throws before any test runs.
vi.mock('../../../../src/core/service-registry.ts', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
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
import { isBusyPoolHealthFailure } from '../../../../src/healthcheck/index.ts';

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

  it('waits behind in-flight work and still gets its full budget once dispatched', async () => {
    // The production shape, and the reason no saturation verdict is needed. The numbers
    // are chosen so the old enqueue-time deadline and the new dispatch-armed one give
    // DIFFERENT answers, which an earlier version of this test did not manage: it used
    // 20ms churn against a 150ms budget, so the probe waited ~20ms and the old timer had
    // 130ms of headroom left. It passed either way and its comment claiming otherwise
    // was arithmetically false.
    //
    // Here the slot is held for 100ms and the probe then executes for 100ms — 200ms
    // total against a 150ms budget. Armed at enqueue, the timer fires at 150ms while the
    // probe is mid-flight. Armed at dispatch, the probe gets its full 150ms of execution
    // and finishes in 100.
    poolState.workMs = 100;
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    const occupying = queue.enqueue('scrape', async () => { await new Promise(r => setTimeout(r, 100)); return 'ok'; });
    await new Promise(r => setTimeout(r, 10)); // let it take the only slot

    await expect(scheduler.runHealthCheck(CFG, undefined, BUDGET)).resolves.toEqual(
      expect.objectContaining({ success: true }),
    );
    await occupying;

    // It really ran, rather than being excused: an execution duration was recorded, and
    // it measures the work rather than the wait.
    const durations = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_healthcheck_duration_ms');
    expect(durations).toHaveLength(1);
    expect(durations[0]![2]).toEqual({ status: 'success' });
    expect(durations[0]![1]).toBeLessThan(BUDGET);
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
      /timed out after/,
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

  it('phrases its failure so the busy-pool tolerance gate still recognises it', async () => {
    // This is a COUPLING, and it decides whether a run lives. isBusyPoolHealthFailure
    // is what stops a probe that queued out under load from aborting research, and it
    // decides by regex-matching /tim(e|ed) out|timeout/ on this message. A rewrite of
    // the message dropped the word entirely — "Health check could not reach a worker
    // within 105000ms" — so a busy pool stopped reading as a timeout, the gate rejected
    // it, and the run aborted at quick-research-orchestrator and research-health. The
    // commit that did it was the one written to stop a busy pool being reported as dead.
    //
    // Asserting the substring here would only restate the implementation. This drives
    // the REAL message through the REAL classifier, so the two cannot drift apart
    // silently again.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);

    let release!: () => void;
    const wedged = new Promise<void>(r => { release = r; });
    const occupying = queue.enqueue('scrape', async () => { await wedged; return 'never'; });
    await new Promise(r => setTimeout(r, 10));

    const message = await scheduler.runHealthCheck(CFG, undefined, BUDGET).then(
      () => { throw new Error('expected the probe to fail'); },
      (err: Error) => err.message,
    );

    expect(isBusyPoolHealthFailure({
      components: [{ component: 'BrowserRuntime', healthy: false, error: `Browser healthcheck failed: ${message}` }],
    } as any)).toBe(true);

    release();
    await occupying;
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
