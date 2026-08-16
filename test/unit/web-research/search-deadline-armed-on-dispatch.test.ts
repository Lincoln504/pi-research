/**
 * The per-query search deadline measures EXECUTION, not the wait for a worker.
 *
 * performSearch used to arm each query's timer before handing it to the browser
 * queue, so a burst larger than the pool could serve inside one budget killed its
 * own tail: every query entered the queue in the same millisecond and, one budget
 * later, the ones still waiting aborted together having done no work. On the run
 * that exposed it, 100 queries went in at 05:46:14.906 and 78 rejected in unison
 * at 05:47:44.90 — exactly 90.000s later — while 22 had completed.
 *
 * The scheduler now reports dispatch through `onDispatch`, and this layer arms its
 * timer there. These tests pin both halves of that: waiting is free, running is
 * still bounded. They fail against a timer armed at call time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runWorkerSearch: vi.fn(),
  runBrowserTask: vi.fn(),
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  getMaxWorkers: vi.fn(() => 1),
  isBrowserAvailable: vi.fn(() => true),
  getSchedulerVersion: vi.fn(() => '1.0.0'),
  generateSchedulerVersion: vi.fn(() => '1.0.0'),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/core/service-registry.ts', () => ({
  getServiceContainer: vi.fn(() => ({})),
  tryGetServiceContainerFromCtx: vi.fn(() => ({})),
}));

import { performSearch } from '../../../src/web-research/browser-search.ts';
import { runWorkerSearch } from '../../../src/infrastructure/browser/task-execution-service.ts';
import type { QueryFailure } from '../../../src/web-research/types.ts';

// Budget per query = SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS = 60ms.
const CFG = { SEARCH_TIMEOUT_MS: 40, BROWSER_TASK_TIMEOUT_MS: 20 } as any;


/** Sleep that rejects when the caller aborts, the way a real worker call does. */
const workUntil = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Aborted')); }, { once: true });
  });

/** onDispatch is the 8th positional parameter of runWorkerSearch. */
const dispatchOf = (args: unknown[]) => args[7] as (() => void) | undefined;

describe('per-query search deadline is armed on dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a query held in the queue past its whole budget still succeeds once dispatched', async () => {
    vi.mocked(runWorkerSearch).mockImplementation(async (query: string, _cfg: any, signal: any, ...rest: any[]) => {
      // Three budgets' worth of queue wait, then dispatch and do fast work. The wait
      // honours the abort signal, so a call-time timer really does kill this query.
      await workUntil(180, signal);
      dispatchOf([query, _cfg, signal, ...rest])?.();
      await workUntil(5, signal);
      return [{ title: 't', url: `https://example.com/${query}`, content: 'c' }];
    });

    const results = await performSearch(['q1'], CFG);

    expect(results.get('q1')).toHaveLength(1);
  });

  it('a query that is slow AFTER dispatch still times out', async () => {
    // The guard must not become toothless — a hung worker has to be cut loose.
    // Paired with a healthy query so the burst is not a total failure — performSearch
    // throws an infrastructure error when EVERY query comes back empty, which would
    // mask the per-query verdict this test is about.
    vi.mocked(runWorkerSearch).mockImplementation(async (query: string, _cfg: any, signal: any, ...rest: any[]) => {
      dispatchOf([query, _cfg, signal, ...rest])?.();
      await workUntil(query === 'slow' ? 400 : 5, signal); // 400ms > the 60ms budget
      return [{ title: 't', url: `https://example.com/${query}`, content: 'c' }];
    });

    const failures = new Map<string, QueryFailure>();
    const results = await performSearch(['ok', 'slow'], CFG, undefined, undefined, undefined, failures);

    expect(results.get('ok')).toHaveLength(1);
    expect(results.get('slow')).toEqual([]);
    expect(failures.get('slow')?.type).toBe('timeout');
  });

  it('each retry attempt earns a fresh budget rather than inheriting the last one', async () => {
    // runWorkerSearch retries internally and dispatches again; a timer left running
    // from the first attempt would kill the second mid-flight.
    vi.mocked(runWorkerSearch).mockImplementation(async (query: string, _cfg: any, signal: any, ...rest: any[]) => {
      const onDispatch = dispatchOf([query, _cfg, signal, ...rest]);
      onDispatch?.();
      await workUntil(45, signal); // most of the budget
      onDispatch?.(); // retry dispatches again
      await workUntil(45, signal); // would exceed 60ms if the clock had never been reset
      return [{ title: 't', url: 'https://example.com/retry', content: 'c' }];
    });

    const results = await performSearch(['retry'], CFG);

    expect(results.get('retry')).toHaveLength(1);
  });

  it('stays disarmed when the scheduler never reports dispatch', async () => {
    // A follower scheduler cannot observe leader-side dispatch, so it never calls
    // onDispatch and bounds the call itself. This layer must not impose a wall of
    // its own in that case — that would reinstate the enqueue-time deadline.
    vi.mocked(runWorkerSearch).mockImplementation(async (query: string, _cfg: any, signal: any) => {
      await workUntil(200, signal); // > 60ms budget, no dispatch signal at all
      return [{ title: 't', url: `https://example.com/${query}`, content: 'c' }];
    });

    const results = await performSearch(['follower'], CFG);

    expect(results.get('follower')).toHaveLength(1);
  });
});
