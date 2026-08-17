/**
 * Regression: the new socket-close abort path (commit 187e5881) rejects
 * runSearch/runScrape/runHealthcheck with PriorityTaskQueue's own
 * "Task <type> aborted while running" / "... aborted while in queue" errors
 * when the caller's AbortSignal fires. isPoolShutdownError() does not — and
 * must not — recognise these as pool-shutdown errors (they mean something
 * different: a leader handover per task-execution-service.ts's isHandover
 * check, which is keyed off isPoolShutdownError and must not fire for a
 * routine follower cancellation). But before this fix, nothing else caught
 * them either: the catch blocks fell straight through to logger.error() plus
 * a browser_*_errors_total increment plus errorTracker.trackError() — BEFORE
 * BrowserServer's own catch block (which correctly demotes via
 * requestAbort.signal.aborted) ever saw the error. Since cancelling a
 * research run routinely cancels its in-flight follower browser tasks, this
 * is a frequent event, not a corner case, and every occurrence polluted
 * error dashboards with expected, routine cancellation.
 *
 * The fix checks the caller's own `signal` parameter directly — the same
 * signal PriorityTaskQueue's abort rejection is a direct consequence of —
 * rather than pattern-matching the queue's rejection text. This mirrors how
 * BrowserServer's catch block and task-execution-service.ts already classify
 * "my own signal aborted" as expected cancellation, and avoids widening
 * isPoolShutdownError() (which would make every cancellation look like a
 * leader handover to task-execution-service.ts and trigger unwarranted
 * forceSchedulerRestart + waitForBrowserPoolIdle churn).
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

// The scheduler resolves its WorkerPoolManager through the service registry;
// hand it a fake manager whose pool's execute() never resolves on its own —
// only an abort (or the test explicitly resolving it) settles it, so the
// test controls exactly when/whether the queue task is RUNNING vs QUEUED.
const poolState = vi.hoisted(() => ({
  executeCalls: 0,
  neverResolve: true,
}));
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => ({
    initialize: vi.fn(async () => {}),
    ensurePool: vi.fn(async () => ({
      execute: vi.fn(() => {
        poolState.executeCalls++;
        return new Promise(() => {}); // never settles; abort is what ends it
      }),
    })),
    decayConsecutiveErrors: vi.fn(),
  })),
}));

import { BrowserTaskScheduler } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';
import { logger } from '../../../../src/logger.ts';
import { metrics } from '../../../../src/utils/metrics.ts';
import { errorTracker } from '../../../../src/utils/error-tracker.ts';
import { getService } from '../../../../src/core/service-registry.ts';

const CFG = {
  SEARCH_TIMEOUT_MS: 5_000,
  SCRAPE_TIMEOUT_MS: 5_000,
  BROWSER_TASK_TIMEOUT_MS: 2_000,
  WORKER_THREADS: 1,
  WORKER_CONCURRENCY: 1,
} as any;

function makeScheduler(): BrowserTaskScheduler {
  const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
  return new BrowserTaskScheduler('test-scheduler', stateManager, {} as any);
}

/** All increment calls for a counter name. */
function incrementCalls(name: string): Array<unknown[]> {
  return vi.mocked(metrics.increment).mock.calls.filter(([n]) => n === name);
}

describe('BrowserTaskScheduler — caller-abort classification (not an ERROR)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolState.executeCalls = 0;
  });

  it('search: an abort while RUNNING is logged at debug, not error, and does not inflate error metrics', async () => {
    const scheduler = makeScheduler();
    const controller = new AbortController();

    const runPromise = scheduler.runSearch('q', CFG, controller.signal);
    await vi.waitFor(() => expect(poolState.executeCalls).toBe(1));

    controller.abort();

    await expect(runPromise).rejects.toThrow(/aborted while running/);

    expect(logger.error).not.toHaveBeenCalled();
    expect(incrementCalls('browser_search_errors_total')).toEqual([]);
    expect(errorTracker.trackError).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.stringContaining('Search cancelled by caller'),
    );
  });

  it('search: an abort while QUEUED is logged at debug, not error, and does not inflate error metrics', async () => {
    const scheduler = makeScheduler();

    // Occupy the single concurrency slot with an uncontrolled task so the
    // second call is forced to sit in the queue.
    const blocker = new AbortController();
    const blockingRun = scheduler.runSearch('blocker', CFG, blocker.signal);
    await vi.waitFor(() => expect(poolState.executeCalls).toBe(1));

    const controller = new AbortController();
    const queuedRun = scheduler.runSearch('queued', CFG, controller.signal);
    // Give the queued call's promise chain a tick to actually enqueue.
    await new Promise((r) => setTimeout(r, 10));

    controller.abort();
    await expect(queuedRun).rejects.toThrow(/aborted while in queue/);

    expect(logger.error).not.toHaveBeenCalled();
    expect(incrementCalls('browser_search_errors_total')).toEqual([]);
    expect(errorTracker.trackError).not.toHaveBeenCalled();

    // Clean up the still-pending blocking call.
    blocker.abort();
    await expect(blockingRun).rejects.toThrow(/aborted while running/);
  });

  it('scrape: an abort while RUNNING is logged at debug, not error, and does not inflate error metrics', async () => {
    const scheduler = makeScheduler();
    const controller = new AbortController();

    const runPromise = scheduler.runScrape('https://example.com', CFG, controller.signal);
    await vi.waitFor(() => expect(poolState.executeCalls).toBe(1));

    controller.abort();

    await expect(runPromise).rejects.toThrow(/aborted while running/);

    expect(logger.error).not.toHaveBeenCalled();
    expect(incrementCalls('browser_scrape_errors_total')).toEqual([]);
    expect(errorTracker.trackError).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.stringContaining('Scrape cancelled by caller'),
    );
  });

  it('healthcheck: an abort while RUNNING is logged at debug, not error, and does not inflate error metrics', async () => {
    const scheduler = makeScheduler();
    const controller = new AbortController();

    const runPromise = scheduler.runHealthCheck(CFG, controller.signal);
    await vi.waitFor(() => expect(poolState.executeCalls).toBe(1));

    controller.abort();

    await expect(runPromise).rejects.toThrow(/aborted while running/);

    expect(logger.error).not.toHaveBeenCalled();
    expect(incrementCalls('browser_healthcheck_errors_total')).toEqual([]);
    // The gauge must not be flipped unhealthy on a routine cancellation.
    expect(vi.mocked(metrics.setGauge)).not.toHaveBeenCalledWith('browser_pool_health', 0);
    expect(errorTracker.trackError).not.toHaveBeenCalled();
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      expect.stringContaining('Healthcheck cancelled by caller'),
    );
  });

  it('a genuine failure (no caller signal, no pool-shutdown shape) still logs error and increments metrics', async () => {
    // Guard against over-broadening: an ordinary in-flight rejection with no
    // signal at all must still be treated as a real error.
    vi.mocked(getService).mockResolvedValueOnce({
      initialize: vi.fn(async () => {}),
      ensurePool: vi.fn(async () => ({
        execute: vi.fn(async () => { throw new Error('genuine worker crash'); }),
      })),
      decayConsecutiveErrors: vi.fn(),
    } as any);

    const scheduler = makeScheduler();
    await expect(scheduler.runSearch('q', CFG)).rejects.toThrow('genuine worker crash');

    expect(logger.error).toHaveBeenCalled();
    expect(incrementCalls('browser_search_errors_total').length).toBe(1);
    expect(errorTracker.trackError).toHaveBeenCalled();
  });
});
