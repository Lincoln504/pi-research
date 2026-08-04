/**
 * Leader-handover recovery tests.
 *
 * The browser pool is hosted by ONE elected leader process shared by every
 * pi-research run on the machine. When that leader exits (its own run finished),
 * any other run with work in flight gets "Worker pool is shutting down" on *every*
 * outstanding task at once.
 *
 * Observed in a real 6-way concurrent run before this fix: a run acquired its slot
 * in the same second the leader tore down its workers, all 20 queries of its search
 * burst failed, and the run died with "all 20 queries encountered worker errors" —
 * roughly two seconds before a fresh leader finished being elected.
 *
 * The bug was that the pool-shutdown branch only *waited*; it never dropped the
 * cached scheduler handle, so the retry reconnected to the dead leader's port and
 * failed identically. These tests pin the two properties that fix it: the stale
 * handle is dropped, and a handover gets more than one attempt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/utils/error-tracker.ts', () => ({
  errorTracker: { trackError: vi.fn() },
}));
vi.mock('../../../../src/infrastructure/browser/browser-lifecycle.ts', () => ({
  waitForBrowserPoolIdle: vi.fn(async () => undefined),
}));

const getSchedulerMock = vi.fn<(config?: unknown, container?: unknown) => Promise<unknown>>();
const forceSchedulerRestartMock = vi.fn<(force?: unknown, container?: unknown) => Promise<void>>();

vi.mock('../../../../src/infrastructure/browser/scheduler-factory.ts', () => ({
  getScheduler: (config?: unknown, container?: unknown) => getSchedulerMock(config, container),
  forceSchedulerRestart: (force?: unknown, container?: unknown) => forceSchedulerRestartMock(force, container),
}));

// Resolve the factory *service* lookup to nothing so the code falls back to the
// module-level scheduler-factory functions mocked above.
vi.mock('../../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  getService: vi.fn(async () => { throw new Error('no service'); }),
}));

import { runWorkerSearch, runBrowserTask } from '../../../../src/infrastructure/browser/task-execution-service.ts';

const POOL_DOWN = 'Worker pool is shutting down';

/** A scheduler whose first `failures` calls die with a handover error, then succeed. */
function schedulerFailingTimes(failures: number, result: unknown) {
  let calls = 0;
  return {
    runSearch: vi.fn(async () => {
      if (calls++ < failures) throw new Error(POOL_DOWN);
      return result;
    }),
    runScrape: vi.fn(async () => {
      if (calls++ < failures) throw new Error(POOL_DOWN);
      return result;
    }),
  };
}

describe('leader handover recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forceSchedulerRestartMock.mockResolvedValue(undefined);
  });

  it('drops the stale scheduler handle instead of retrying into the dead leader', async () => {
    const scheduler = schedulerFailingTimes(1, [{ title: 't', url: 'https://x' }]);
    getSchedulerMock.mockResolvedValue(scheduler);

    const out = await runWorkerSearch('q');

    expect(out).toEqual([{ title: 't', url: 'https://x' }]);
    // The whole point: a handover MUST force the cached leader handle to be
    // re-resolved. Waiting alone reconnects to the corpse.
    expect(forceSchedulerRestartMock).toHaveBeenCalled();
  }, 20_000);

  it('survives a handover that outlasts the single generic retry', async () => {
    // Two consecutive failures would exhaust the old budget (retries = 1) and kill
    // the query; an election can easily span that long.
    const scheduler = schedulerFailingTimes(2, [{ title: 'ok', url: 'https://y' }]);
    getSchedulerMock.mockResolvedValue(scheduler);

    await expect(runWorkerSearch('q')).resolves.toEqual([{ title: 'ok', url: 'https://y' }]);
  }, 20_000);

  it('still gives up once the handover budget is genuinely exhausted', async () => {
    // A leader that never comes back must not retry forever.
    const scheduler = schedulerFailingTimes(Number.MAX_SAFE_INTEGER, null);
    getSchedulerMock.mockResolvedValue(scheduler);

    await expect(runWorkerSearch('q')).rejects.toThrow(POOL_DOWN);
  }, 30_000);

  it('applies the same recovery to scrape tasks', async () => {
    const scheduler = schedulerFailingTimes(2, '<html>ok</html>');
    getSchedulerMock.mockResolvedValue(scheduler);

    await expect(runBrowserTask('https://example.com', 'scrape')).resolves.toBe('<html>ok</html>');
    expect(forceSchedulerRestartMock).toHaveBeenCalled();
  }, 20_000);

  it('does not consume handover attempts for an unrelated transient error', async () => {
    let calls = 0;
    getSchedulerMock.mockResolvedValue({
      runSearch: vi.fn(async () => {
        if (calls++ < 1) throw new Error('socket hang up');
        return [];
      }),
      runScrape: vi.fn(),
    });

    await expect(runWorkerSearch('q')).resolves.toEqual([]);
  }, 20_000);
});
