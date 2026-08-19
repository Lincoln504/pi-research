/**
 * A task's deadline measures its EXECUTION, not how long it waited for a worker.
 *
 * The scheduler used to arm the timer before enqueuing, so a task that sat behind a
 * saturated queue burned its entire budget waiting and then aborted having done no work at
 * all. That made the number of tasks a burst could complete `capacity x (budget / latency)`
 * rather than the number submitted — measured on a live run, 78 of 100 searches aborted at
 * the deadline without ever reaching a worker, and the burst returned a fraction of its
 * results. A queue absorbs volume by making work WAIT; killing whatever it could not reach
 * in time is not backpressure, it is data loss.
 *
 * These tests pin that: with a worker slower than the per-task budget, a queued task still
 * gets its full budget once dispatched. They fail against the enqueue-time timer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/utils/error-tracker.ts', () => ({
  errorTracker: { trackError: vi.fn() },
}));
vi.mock('../../../../src/utils/metrics.ts', () => ({
  metrics: { increment: vi.fn(), observe: vi.fn(), setGauge: vi.fn(), session: { increment: vi.fn(), setGauge: vi.fn(), observe: vi.fn() }, },
}));
// Zeroed so this file's ms-scale deadline assertions stay exact; everything else
// (getHealthCheckBudgetMs, etc.) stays real. The real cold-start allowance itself is
// covered by healthcheck-budget.test.ts.
vi.mock('../../../../src/infrastructure/browser/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/infrastructure/browser/config.ts')>();
  return { ...actual, COLD_START_ALLOWANCE_MS: 0 };
});

// One worker slot, so the second and later tasks genuinely queue behind the first.
const poolState = vi.hoisted(() => ({ workMs: 0 }));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    ensurePool: vi.fn(async () => ({
      execute: vi.fn(async (task: { query?: string; url?: string }) => {
        await new Promise(r => setTimeout(r, poolState.workMs));
        return { results: [{ title: 't', url: `https://example.com/${task.query ?? task.url}`, content: 'c' }] };
      }),
    })),
    decayConsecutiveErrors: vi.fn(),
  })),
}));

import { BrowserTaskScheduler } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';
import { metrics } from '../../../../src/utils/metrics.ts';

// Budget per task = SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS = 120ms.
// Each task does 80ms of work, so four of them queued serially span ~320ms — well past
// the budget of any task that had to wait.
const CFG = {
  SEARCH_TIMEOUT_MS: 100,
  SCRAPE_TIMEOUT_MS: 100,
  BROWSER_TASK_TIMEOUT_MS: 20,
  WORKER_THREADS: 1,
  WORKER_CONCURRENCY: 1,
} as any;

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('deadline-scheduler', stateManager, {} as any);
}

describe('scheduler deadline excludes queue wait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolState.workMs = 80;
  });

  it('serves every queued search even when the backlog outlasts the per-task budget', async () => {
    const scheduler = makeScheduler();
    const queries = ['q1', 'q2', 'q3', 'q4'];

    const settled = await Promise.allSettled(queries.map(q => scheduler.runSearch(q, CFG)));

    // Under the old enqueue-time timer, q3 and q4 wait ~160-240ms against a 120ms budget
    // and reject without ever running.
    for (const [i, r] of settled.entries()) {
      expect(r.status, `query ${queries[i]}`).toBe('fulfilled');
    }
  });

  it('serves every queued scrape too', async () => {
    const scheduler = makeScheduler();
    const urls = ['https://a.example.com', 'https://b.example.com', 'https://c.example.com', 'https://d.example.com'];

    const settled = await Promise.allSettled(urls.map(u => scheduler.runScrape(u, CFG)));

    for (const [i, r] of settled.entries()) {
      expect(r.status, `url ${urls[i]}`).toBe('fulfilled');
    }
  });

  it('still enforces the budget on a task that is genuinely slow once running', async () => {
    // The deadline must not become toothless: a single task, no queue wait, whose work
    // exceeds the budget still has to fail. Otherwise a hung worker pins a slot forever.
    poolState.workMs = 400; // > 120ms budget
    const scheduler = makeScheduler();

    await expect(scheduler.runSearch('slow', CFG)).rejects.toThrow(/timed out/);
  });

  it('tells the caller when the task was dispatched, not when it was accepted', async () => {
    // Callers keep their own guard over this call (performSearch does). They arm it
    // from this signal, so it has to fire at dispatch — firing it on acceptance would
    // hand them back the enqueue-time deadline this whole change removes, and never
    // firing it would leave their guard dead.
    const scheduler = makeScheduler();
    const dispatchOrder: string[] = [];

    const record = (name: string) => (event: string) => dispatchOrder.push(`${name}:${event}`);
    const first = scheduler.runSearch('first', CFG, undefined, record('first'));
    // Queued behind `first` on a single-slot pool: not dispatched yet, so silent.
    const second = scheduler.runSearch('second', CFG, undefined, record('second'));

    await new Promise(r => setTimeout(r, 20)); // first is running, second is waiting
    expect(dispatchOrder).toEqual(['first:dispatched']);

    await Promise.all([first, second]);
    // Each task reports both edges, and the second is not dispatched until the first
    // has settled — the caller's guard therefore never runs while nothing executes.
    expect(dispatchOrder).toEqual([
      'first:dispatched', 'first:settled', 'second:dispatched', 'second:settled',
    ]);
  });

  it('reports scrape dispatch the same way', async () => {
    const scheduler = makeScheduler();
    const dispatched: string[] = [];

    await scheduler.runScrape('https://a.example.com', CFG, undefined, e => dispatched.push(e));

    expect(dispatched).toEqual(['dispatched', 'settled']);
  });

  it('a caller whose dispatch listener throws does not take the task down with it', async () => {
    const scheduler = makeScheduler();

    await expect(
      scheduler.runSearch('q', CFG, undefined, () => { throw new Error('caller bug'); }),
    ).resolves.toBeDefined();
  });

  it('reports a queued task\'s DURATION as its execution, not its elapsed span', async () => {
    // The helpers that compute this are unit-tested next door, but nothing asserted the
    // scheduler used them: swapping `executionMs(dispatchedAt, startTime)` back for
    // `Date.now() - startTime` restores the 51s-vs-5.8s misdiagnosis in full and leaves
    // that file green. The only other test observing this metric matches its value with
    // `expect.anything()`. This one drives a real queue wait and reads the number.
    const scheduler = makeScheduler();

    // Occupy the single slot so the measured task genuinely waits behind it.
    const blocker = scheduler.runSearch('blocker', CFG);
    await new Promise(r => setTimeout(r, 10));
    await Promise.all([blocker, scheduler.runSearch('measured', CFG)]);

    const durations = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_search_duration_ms');
    expect(durations).toHaveLength(2);
    // Both ran for ~80ms. The second waited ~80ms more; charging that to the work would
    // report ~160ms. Well inside the 120ms budget either way, so only the measurement
    // distinguishes them.
    for (const d of durations) expect(d[1]).toBeLessThan(130);
  });

  it('records queue wait on a task that FAILED, not only on one that succeeded', async () => {
    // The tasks that wait longest are precisely the ones that do not succeed, so
    // recording this only on the success path censored the tail the metric exists to
    // expose — the saturated bursts were invisible in it by construction.
    poolState.workMs = 400; // > the 120ms budget, so this one times out
    const scheduler = makeScheduler();

    await expect(scheduler.runSearch('slow', CFG)).rejects.toThrow(/timed out/);

    const waits = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_search_queue_wait_ms');
    expect(waits).toHaveLength(1);
    expect(waits[0]![2]).toEqual({ dispatched: 'yes' });
  });

  it('labels a task that never reached a worker, and reports its whole wait', async () => {
    // An abandoned task has no dispatch instant, so its wait is the full elapsed span
    // and is still running when the caller gives up — a lower bound, not a completed
    // measurement. Recording it as `queueWaitMs`'s zero would pull the distribution
    // DOWNWARD in exactly the bursts where it should spike, which is worse than not
    // recording it at all.
    const scheduler = makeScheduler();
    const queue = (scheduler as any).getPriorityQueue(CFG);
    queue.process = () => {}; // dispatch nothing, so the task only ever waits

    const caller = new AbortController();
    const running = scheduler.runSearch('abandoned', CFG, caller.signal);
    await new Promise(r => setTimeout(r, 60));
    caller.abort();

    await expect(running).rejects.toThrow();

    const waits = vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_search_queue_wait_ms');
    expect(waits).toHaveLength(1);
    expect(waits[0]![2]).toEqual({ dispatched: 'no' });
    expect(waits[0]![1]).toBeGreaterThanOrEqual(50); // the real wait, not zero
  });

  it('records scrape queue wait on failure too', async () => {
    poolState.workMs = 400;
    const scheduler = makeScheduler();

    await expect(scheduler.runScrape('https://slow.example.com', CFG)).rejects.toThrow(/timed out/);

    expect(vi.mocked(metrics.observe).mock.calls.filter(c => c[0] === 'browser_scrape_queue_wait_ms')).toHaveLength(1);
  });

  it('reports the timeout without blaming queue wait', async () => {
    // The old message said "(including queue wait)", which sent readers looking at pool
    // saturation for what is now purely a slow-execution failure.
    poolState.workMs = 400;
    const scheduler = makeScheduler();

    await expect(scheduler.runSearch('slow', CFG)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('including queue wait') }),
    );
  });
});
