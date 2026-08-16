/**
 * search() — per-query failure attribution.
 *
 * A query that yields nothing can mean two very different things, and the
 * researcher agent acts on the difference: an empty result set is feedback about
 * the QUERY (broaden it, rephrase it), while a timeout or a dead browser worker
 * says nothing about the query at all. Reporting the latter as "the query may be
 * too narrow" — which is what every zero-result query used to get — sends the
 * agent off rewriting perfectly good queries whenever the infrastructure is what
 * broke. That misdirection was observed in the wild when a pinned circuit breaker
 * fast-failed 19 of a 20-query burst.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runWorkerSearch: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/config.ts', () => ({
  getMaxWorkers: () => 2,
}));

import { search } from '../../../src/web-research/search.ts';
import { runWorkerSearch } from '../../../src/infrastructure/browser/task-execution-service.ts';

const okResult = [{ title: 'T', url: 'https://example.com/a', content: 'C' }];

describe('search — attributes an empty result set to the right cause', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // performSearch short-circuits to canned results when BOTH mock env vars are
    // set; make sure neither is, or the worker mock below is never consulted.
    delete process.env['PI_RESEARCH_MOCK_SEARCH'];
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
  });

  it('labels a genuinely empty search as empty_results (the query really may be too narrow)', async () => {
    vi.mocked(runWorkerSearch).mockImplementation(async (q: string) =>
      q === 'good' ? okResult : [],
    );

    const results = await search(['good', 'nothing-found']);

    const empty = results.find((r) => r.query === 'nothing-found')!;
    expect(empty.error?.type).toBe('empty_results');
    expect(empty.error?.message).toMatch(/too narrow/);
  });

  it('labels a dead worker as service_unavailable and tells the agent NOT to rewrite the query', async () => {
    vi.mocked(runWorkerSearch).mockImplementation(async (q: string) => {
      if (q === 'good') return okResult;
      throw new Error('Worker pool is shutting down');
    });

    const results = await search(['good', 'broken']);

    const failed = results.find((r) => r.query === 'broken')!;
    expect(failed.error?.type).toBe('service_unavailable');
    expect(failed.error?.message).not.toMatch(/too narrow/);
    expect(failed.error?.message).toMatch(/do not rewrite the query/i);
    // The real cause travels with it, so the agent can relay something useful.
    expect(failed.error?.message).toMatch(/Worker pool is shutting down/);
  });

  it('does not attach an error to a query that succeeded', async () => {
    vi.mocked(runWorkerSearch).mockResolvedValue(okResult);

    const results = await search(['good']);

    expect(results[0]!.error).toBeUndefined();
    expect(results[0]!.results).toHaveLength(1);
  });

  it('labels a query whose results ALL deduplicated away as all_duplicates, not "too narrow"', async () => {
    // Cross-query dedup: the second query returns only a URL the first already
    // surfaced. Pre-fix it got no failures entry, so search() attached the
    // default empty_results "query may be too narrow" message — sending the
    // researcher off rewriting a query that worked.
    vi.mocked(runWorkerSearch).mockImplementation(async (q: string) => {
      if (q === 'first') return okResult;
      // Resolve after 'first' so the dedup order is deterministic.
      await new Promise((r) => setTimeout(r, 20));
      return [{ title: 'Same page', url: 'https://example.com/a', content: 'C' }];
    });

    const results = await search(['first', 'second']);

    const deduped = results.find((r) => r.query === 'second')!;
    expect(deduped.results).toHaveLength(0);
    expect(deduped.error?.type).toBe('all_duplicates');
    expect(deduped.error?.message).toMatch(/duplicated URLs already returned by earlier queries/);
    expect(deduped.error?.message).not.toMatch(/too narrow/);
  });

  it('threads the sessionId through to runWorkerSearch (per-session circuit breaker applies to search)', async () => {
    // The scrape path keys per-session breakers via BrowserTask.sessionId; the
    // search path hard-coded undefined at this hop, so search failures always
    // hit the GLOBAL breaker regardless of session.
    vi.mocked(runWorkerSearch).mockResolvedValue(okResult);

    await search(['q'], undefined, undefined, undefined, undefined as any, 'pisess-1a2b3c4d');

    expect(runWorkerSearch).toHaveBeenCalledWith(
      'q', undefined, expect.any(AbortSignal), 1, 'pisess-1a2b3c4d', expect.anything(),
      // handoverRetries left at its default, then the dispatch listener performSearch
      // arms its per-query deadline from.
      undefined, expect.any(Function),
    );
  });

  it('propagates a cancellation instead of reporting per-query failures', async () => {
    const controller = new AbortController();
    vi.mocked(runWorkerSearch).mockImplementation(async () => {
      controller.abort();
      return [];
    });

    // Previously this was swallowed into `{ type: 'unknown', message: 'Aborted' }`
    // per query and the run carried on to synthesize from nothing.
    await expect(search(['q1'], undefined, controller.signal)).rejects.toThrow('Aborted');
  });
});
