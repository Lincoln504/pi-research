/**
 * Integration: a search burst far larger than the worker pool must deliver every query.
 *
 * The unit tests for this cover one layer each. This one runs the whole chain the
 * failing run ran — performSearch's lanes and per-query guard, task-execution-service's
 * circuit breaker and retries, BrowserTaskScheduler's dispatch-armed deadline, and
 * PriorityTaskQueue's admission — with only the browser worker itself replaced. It is
 * the end-to-end statement of the fix: three layers agreeing that queue wait is not
 * charged to the work.
 *
 * The shape is taken from the run that exposed the bug: 100 queries, a pool of 6, and a
 * per-query latency high enough that the burst cannot finish inside one budget. Under
 * the old enqueue-time deadlines that run completed 22 of 100 and returned 49 results.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The only thing replaced: the worker that would drive a real browser.
const pool = vi.hoisted(() => ({ latencyMs: 40, scrapeLatencyMs: 40, inFlight: 0, peakInFlight: 0, executed: 0 }));

vi.mock('../../src/core/service-registry.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/service-registry.ts')>();
  return {
    ...actual,
    getService: vi.fn(async () => ({
      initialize: vi.fn(async () => {}),
      ensurePool: vi.fn(async () => ({
        execute: vi.fn(async (task: { query?: string; type?: string }) => {
          pool.inFlight++;
          if (task.type === 'search') pool.executed++;
          pool.peakInFlight = Math.max(pool.peakInFlight, pool.inFlight);
          try {
            await new Promise(r => setTimeout(r, task.type === 'scrape' ? pool.scrapeLatencyMs : pool.latencyMs));
            return { results: [{ title: `t:${task.query}`, url: `https://example.com/${encodeURIComponent(task.query ?? '')}`, content: 'c' }] };
          } finally {
            pool.inFlight--;
          }
        }),
      })),
      decayConsecutiveErrors: vi.fn(),
    })),
  };
});

// Leader election and its browser-init lock are out of scope here; hand the real
// scheduler back directly so everything BELOW performSearch is production code.
vi.mock('../../src/infrastructure/browser/scheduler-factory.ts', async () => {
  const { BrowserTaskScheduler } = await import('../../src/infrastructure/browser/browser-task-scheduler.ts');
  const stateManager = { getBrowserServer: async () => null } as any;
  let instance: any = null;
  return {
    getScheduler: async () => {
      instance ??= new BrowserTaskScheduler('burst-e2e', stateManager, {} as any);
      return instance;
    },
    forceSchedulerRestart: async () => {},
    __reset: () => { instance = null; },
  };
});

import { performSearch } from '../../src/web-research/browser-search.ts';

const WORKERS = 6;
const QUERIES = 100;

// Per-query budget = SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS.
// 40ms of work x 100 queries / 6 workers is ~670ms of wall clock — more than five
// times a single query's 120ms budget, which is the condition that used to be fatal.
const CFG = {
  SEARCH_TIMEOUT_MS: 100,
  BROWSER_TASK_TIMEOUT_MS: 20,
  SCRAPE_TIMEOUT_MS: 100,
  WORKER_THREADS: WORKERS,
  WORKER_CONCURRENCY: 1,
} as any;

describe('search burst end to end', () => {
  beforeEach(() => {
    pool.latencyMs = 40;
    pool.scrapeLatencyMs = 40;
    pool.inFlight = 0;
    pool.peakInFlight = 0;
    pool.executed = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delivers all 100 queries through a pool of 6, none discarded for waiting', async () => {
    const queries = Array.from({ length: QUERIES }, (_, i) => `query number ${i}`);
    const failures = new Map<string, { type: string; message: string }>();

    const started = Date.now();
    const results = await performSearch(queries, CFG, undefined, undefined, undefined, failures as any);
    const elapsed = Date.now() - started;

    // Every query ran and returned, and none was reported to a researcher as a failure.
    expect(results.size).toBe(QUERIES);
    const delivered = [...results.values()].filter(r => r.length > 0).length;
    expect(delivered).toBe(QUERIES);
    expect(pool.executed).toBe(QUERIES);
    expect([...failures.keys()]).toEqual([]);

    // The burst outlasts a single query's budget many times over, which is what used to
    // be fatal at the whole-burst level.
    expect(elapsed).toBeGreaterThan(CFG.SEARCH_TIMEOUT_MS + CFG.BROWSER_TASK_TIMEOUT_MS);

    // What this test does NOT establish, stated because an earlier version of this
    // comment claimed it did ("the old build finished 22 of these and reported the other
    // 78 as timeouts"): that is false for THIS configuration. `performSearch` sizes its
    // lanes to `min(WORKER_THREADS, N)` and the queue's capacity is
    // `WORKER_THREADS x WORKER_CONCURRENCY` — the same number — so a burst on its own
    // never builds a backlog and no individual query waits. Reverting the deadline to
    // enqueue time leaves this test green. The `elapsed` guard proves aggregate
    // throughput, not any single query's wait, so it cannot rescue the claim either.
    //
    // The dispatch-armed deadline is exercised by the third test below, which contends
    // the pool first. This one is a whole-pipeline smoke test: 100 queries in, 100
    // results out, no failure entries, lanes and pool wired end to end.
  }, 120_000);

  it('dispatches through lanes rather than dumping the whole plan into the shared queue', async () => {
    const queries = Array.from({ length: QUERIES }, (_, i) => `bounded ${i}`);

    await performSearch(queries, CFG, undefined, undefined, undefined, new Map() as any);

    // This is the CALLER-side bound and only that. A burst that hands all 100 queries to
    // the queue at once delays the scrapes, healthchecks and other runs sharing the same
    // pool, so lanes matter on their own — but the queue's own capacity is not under
    // test here, and an earlier version of this comment claimed both were: raising the
    // priority queue's concurrency arbitrarily leaves this assertion untouched, because
    // lanes alone already cap it.
    expect(pool.peakInFlight).toBeLessThanOrEqual(WORKERS);
    // And they really do run in parallel, rather than the lane loop serialising to one.
    expect(pool.peakInFlight).toBeGreaterThan(1);
  }, 120_000);

  it('delivers every query even when the pool is already full of other work', async () => {
    // This is the case the dispatch-armed deadlines actually cover. A burst on its own
    // cannot build a backlog — its lanes are sized to the pool, so each query is
    // dispatched about as soon as it is submitted, and an enqueue-time deadline would
    // never notice. The pool is shared, though: scrapes, healthchecks and other
    // concurrent runs take the same slots. Then a search really does wait, and whether
    // it survives depends entirely on which clock its budget is measured against.
    const { getScheduler } = await import('../../src/infrastructure/browser/scheduler-factory.ts');
    const scheduler: any = await getScheduler();

    // Fill every slot with scrapes that outlast a search's whole budget, and keep them
    // coming, so the burst spends real time queued rather than running.
    // Only the SCRAPES are slow. The searches stay fast, so anything that fails here
    // failed while WAITING, which is precisely the distinction under test.
    pool.scrapeLatencyMs = 400; // > a search's whole 120ms budget
    // The scrapes need a budget that OUTLASTS their own work, or their deadline fires,
    // the queue releases their slots early, and the searches never actually wait.
    const SCRAPE_CFG = { ...CFG, SCRAPE_TIMEOUT_MS: 2_000 };
    let keepScraping = true;
    const scrapers = Array.from({ length: WORKERS }, async () => {
      while (keepScraping) {
        await scheduler.runScrape('https://occupied.example.com', SCRAPE_CFG).catch(() => {});
      }
    });

    // Let the scrapes take the pool before the burst starts.
    await new Promise(r => setTimeout(r, 50));

    const queries = Array.from({ length: 24 }, (_, i) => `contended ${i}`);
    const failures = new Map<string, { type: string; message: string }>();
    let results: Map<string, unknown[]>;
    const started = Date.now();
    try {
      results = await performSearch(queries, CFG, undefined, undefined, undefined, failures as any) as any;
    } finally {
      keepScraping = false;
      await Promise.all(scrapers);
    }
    const elapsed = Date.now() - started;

    // Every query waited its turn and then ran. Measured against the old enqueue-time
    // clock, the ones behind a 400ms scrape exhausted their 120ms budget while queued
    // and aborted having done no work at all.
    expect([...results.values()].filter(r => r.length > 0).length).toBe(queries.length);
    expect([...failures.keys()]).toEqual([]);

    // Guard against this test quietly stopping reproducing the condition: the burst
    // must have spent longer than a single query's budget, which on 24 fast queries
    // through 6 lanes can only have been queue wait.
    expect(elapsed).toBeGreaterThan(CFG.SEARCH_TIMEOUT_MS + CFG.BROWSER_TASK_TIMEOUT_MS);
  }, 120_000);

  it('still fails a query whose worker hangs, without taking the burst down', async () => {
    // The deadline must remain real once a query is running. One slow query, the rest
    // healthy: the slow one fails on its own merits and the other 99 are unaffected.
    const queries = Array.from({ length: QUERIES }, (_, i) => `mixed ${i}`);
    const slow = 'mixed 7';

    const { getScheduler } = await import('../../src/infrastructure/browser/scheduler-factory.ts');
    const scheduler: any = await getScheduler();
    const realRunSearch = scheduler.runSearch.bind(scheduler);
    scheduler.runSearch = async (q: string, cfg: any, signal: any, onTaskEvent: any) => {
      if (q !== slow) return realRunSearch(q, cfg, signal, onTaskEvent);
      onTaskEvent?.('dispatched');
      await new Promise((_, reject) => setTimeout(() => reject(new Error('worker hung')), 10_000));
    };

    try {
      const failures = new Map<string, { type: string; message: string }>();
      const results = await performSearch(queries, CFG, undefined, undefined, undefined, failures as any);

      expect(results.get(slow)).toEqual([]);
      expect(failures.get(slow)?.type).toBe('timeout');
      const delivered = [...results.entries()].filter(([q, r]) => q !== slow && r.length > 0).length;
      expect(delivered).toBe(QUERIES - 1);
    } finally {
      scheduler.runSearch = realRunSearch;
    }
  }, 120_000);
});
