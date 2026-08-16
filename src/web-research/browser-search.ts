/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch } from '../infrastructure/browser/task-execution-service.ts';
import { getMaxWorkers } from '../infrastructure/browser/config.ts';
import { logger } from '../logger.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { normalizeUrl } from '../utils/url-utils.ts';
import type { SearchResult, QueryFailure } from './types.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import { getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';

/**
 * Orchestrate high-fidelity search across multiple queries.
 * Uses true multithreaded worker processes for maximum burst performance.
 * Each worker maintains its own "warm" browser process.
 */
export async function performSearch(
    queries: string[],
    config?: Config,
    signal?: AbortSignal,
    onProgress?: (links: number) => void,
    container: ServiceContainer = getServiceContainer(),
    /**
     * Optional sink for per-query FAILURES (timeout / worker error / cross-query
     * dedup). Populated as an out-param rather than folded into the return value
     * because the returned map's `query -> results` shape is what every caller
     * consumes; a query absent from this map produced zero results with no
     * failure, i.e. the search really did come back empty. Without this the
     * caller cannot tell those apart and reports every empty query as a
     * too-narrow query.
     */
    failures?: Map<string, QueryFailure>,
    /**
     * Session/research id keying the per-session circuit breaker inside
     * runWorkerSearch — mirroring the scrape path, which threads it via
     * BrowserTask.sessionId. Callers without a session (undefined) share the
     * global breaker, as before.
     */
    sessionId?: string,
): Promise<Map<string, SearchResult[]>> {
    const startTime = Date.now();
    const resultMap = new Map<string, SearchResult[]>();
    const seenUrls = new Set<string>();

    // FULL_MOCK_MODE: When both PI_RESEARCH_MOCK_SEARCH and PI_RESEARCH_MOCK_SCRAPE
    // are true, return deterministic mock results without spawning any worker processes.
    // This gate keeps CI tests deterministic and fast, and prevents real worker pool
    // failures from cascading into test flakiness.
    const fullMockMode = process.env['PI_RESEARCH_MOCK_SEARCH'] === 'true' &&
                         process.env['PI_RESEARCH_MOCK_SCRAPE'] === 'true';
    if (fullMockMode) {
      logger.log('[Search] FULL_MOCK_MODE enabled — returning mock results without worker pool');
      for (const q of queries) {
        const domain = q.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 30);
        resultMap.set(q, [{
          title: `Mock result for: ${q}`,
          url: `https://mock.example.com/${domain}`,
          content: `This is a mock search result for query "${q}".`,
        }]);
      }
      return resultMap;
    }

    const maxWorkers = getMaxWorkers(config);

    metrics.setGauge('browser_search_max_workers', maxWorkers);
    metrics.increment('browser_search_orchestrations_total', 1);

    logger.log(`[Search] Orchestrating ${queries.length} queries across ${maxWorkers} worker processes...`);

    // Call onProgress(0) immediately to clear any 'searching' placeholder in the UI
    if (onProgress) onProgress(0);

    // Hard cap per query so a single Cloudflare block or hung browser worker
    // cannot stall the entire Promise.all burst.
    //
    // The budget is the worker's nav budget (SEARCH_TIMEOUT_MS) PLUS the
    // queue-wait/overhead margin (BROWSER_TASK_TIMEOUT_MS), mirroring the
    // scheduler's own task-timeout ceiling in BrowserTaskScheduler.runSearch
    // (= SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS). This clock starts at
    // ENQUEUE (before runWorkerSearch queues onto the shared browser pool), so
    // a budget of only SEARCH_TIMEOUT_MS would let a query that sat in the
    // saturated worker queue burn its ENTIRE nav budget waiting for a slot and
    // abort with zero actual search work — exactly the "Query timed out after
    // 45000ms (likely blocked or slow startup)" cascade observed under
    // concurrent load. Including the margin lets a queued query still use its
    // full nav budget once a worker picks it up, and keeps this layer's hard
    // cap coherent with the scheduler's so it never preempts the worker's own
    // (post-dequeue) deadline.
    const QUERY_TIMEOUT_MS = (config?.SEARCH_TIMEOUT_MS ?? 45_000) + (config?.BROWSER_TASK_TIMEOUT_MS ?? 10_000);

    // Deduplicated: resultMap and the failures map are both keyed by the query
    // string, so two tasks for the same string race last-writer-wins — instance A
    // delivering results, then instance B timing out, discarded A's results and
    // marked the query failed. One task per distinct string closes that (and stops
    // paying for the duplicate browser work).
    const filteredQueries = [...new Set(queries.filter(q => q.trim()))];
    let timeoutCount = 0;
    let errorCount = 0;
    // Keep one representative worker error so total-failure surfaces the real
    // cause (e.g. a worker that cannot load its module) instead of a generic
    // timeout guess that misdirects to the network or system load.
    let sampleWorkerError = '';

    const runQuery = async (query: string): Promise<void> => {
        const queryStartTime = Date.now();
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), QUERY_TIMEOUT_MS);
        safeUnref(timeoutId);

        try {
            if (signal?.aborted) {
                resultMap.set(query, []);
                return;
            }

            const querySignal = signal
              ? AbortSignal.any([signal, timeoutController.signal])
              : timeoutController.signal;

            const results = await runWorkerSearch(query, config, querySignal, 1, sessionId, container);
            const queryDuration = Date.now() - queryStartTime;
            metrics.observe('browser_search_query_duration_ms', queryDuration);

            if (results?.length > 0) {
                metrics.increment('browser_search_queries_total', 1, { status: 'success' });
                metrics.increment('browser_search_results_total', results.length);
                logger.debug(`[Search] Worker returned ${results.length} results for: ${query}`);

                const uniqueResults: SearchResult[] = [];
                for (const r of results) {
                    // Dedup across ALL queries (seenUrls), not just within this query.
                    // The same URL surfacing for several queries would otherwise repeat
                    // its snippet in the combined output, wasting context tokens; this
                    // also makes seenUrls.size a true cross-query unique count for the
                    // progress callback and the unique-URLs metric.
                    // Dedup on the NORMALIZED url (consistent with shared-links / knowledge store),
                    // so http/https, trailing-slash, and tracking-param variants of the same page
                    // collapse to one — otherwise snippets repeat across queries (wasting context)
                    // and seenUrls.size over-counts uniques for the progress callback / metric.
                    const key = r.url ? normalizeUrl(r.url) : '';
                    if (key && !seenUrls.has(key)) {
                        seenUrls.add(key);
                        uniqueResults.push(r);
                    }
                }
                if (uniqueResults.length === 0) {
                    // Every raw result deduplicated away against URLs earlier
                    // queries in this batch already returned. Without an entry
                    // here the query fell through to the empty_results default —
                    // "the query may be too narrow" — sending the researcher off
                    // rewriting a query that actually worked.
                    failures?.set(query, {
                        type: 'all_duplicates',
                        message: `All ${results.length} results for this query duplicated URLs already returned by earlier queries in this batch. The query succeeded but surfaced nothing new — do not rewrite it; try a different angle only if you still need additional sources.`,
                    });
                }
                resultMap.set(query, uniqueResults);
            } else {
                metrics.increment('browser_search_queries_total', 1, { status: 'no_results' });
                resultMap.set(query, []);
            }
        } catch (error) {
            const queryDuration = Date.now() - queryStartTime;
            const isTimeout = timeoutController.signal.aborted && !signal?.aborted;
            const status = isTimeout ? 'timeout' : 'error';
            
            if (isTimeout) timeoutCount++;
            else errorCount++;

            metrics.observe('browser_search_query_duration_ms', queryDuration, { status });
            metrics.increment('browser_search_queries_total', 1, { status });
            
            if (isTimeout) {
                logger.warn(`[Search] Query timed out after ${QUERY_TIMEOUT_MS}ms — likely starved waiting for a free browser worker under concurrent load, or a slow/blocked search provider: "${query}"`);
                failures?.set(query, {
                    type: 'timeout',
                    message: `Search timed out after ${QUERY_TIMEOUT_MS}ms before returning anything. This says nothing about the query — the browser pool was saturated or the search provider was slow/blocked. Retrying the same query later is reasonable.`,
                });
            } else {
                const msg = error instanceof Error ? error.message : String(error);
                if (msg !== 'Aborted') {
                    if (!sampleWorkerError) sampleWorkerError = msg;
                    logger.error(`[Search] Worker failed for "${query}": ${msg}`);
                    failures?.set(query, {
                        type: 'service_unavailable',
                        message: `The search backend failed for this query (${msg}). This is an infrastructure failure, not a signal about the query itself — do not rewrite the query in response to it.`,
                    });
                } else if (!signal?.aborted) {
                    // A worker-side 'Aborted' with no caller abort (a pool drain or
                    // leader handover cancelling the task) is an infrastructure
                    // interruption. Without an entry here the query fell through to
                    // the empty_results default — "the query may be too narrow" —
                    // the exact misattribution this map exists to prevent. The
                    // caller-abort case stays unrecorded: the post-loop signal
                    // check reports the cancellation itself.
                    failures?.set(query, {
                        type: 'service_unavailable',
                        message: 'The search task was cancelled on the worker side (pool drain or leader handover) before completing. This says nothing about the query — do not rewrite it; retrying the same query later is reasonable.',
                    });
                }
            }
            resultMap.set(query, []);
        } finally {
            clearTimeout(timeoutId);
            if (onProgress) onProgress(seenUrls.size);
        }
    };

    // Dispatch through a bounded number of lanes instead of handing every query to
    // Promise.all at once.
    //
    // The old form started ALL N queries simultaneously, which meant N minus maxWorkers of
    // them sat in the shared browser queue with their per-query deadline ALREADY TICKING —
    // the clock started at enqueue, not when a worker picked the query up. That made the
    // number of queries which could possibly succeed `maxWorkers x (budget / latency)`
    // rather than N. Measured on a level-3 run: 100 queries dispatched into 6 workers went
    // 94 deep in the queue, 78 of them aborted at the 90s mark having never run, and the
    // burst returned 49 results. Worse, each of those was reported to its researcher as a
    // timeout with "retrying the same query later is reasonable", so the next round
    // re-queued them and the burst grew.
    //
    // A lane only picks up its next query when the previous one finishes, so a query's
    // deadline now measures the work rather than the wait, the shared queue never builds a
    // backlog, and every query eventually runs. The burst takes longer in wall-clock terms;
    // it no longer discards most of itself to get there.
    const lanes = Math.max(1, Math.min(maxWorkers, filteredQueries.length));
    let nextIndex = 0;
    const runLane = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex++;
            if (index >= filteredQueries.length) return;
            // Stop pulling new work once the caller has cancelled; queries already
            // dispatched settle through their own abort path.
            if (signal?.aborted) return;
            await runQuery(filteredQueries[index]!);
        }
    };
    await Promise.all(Array.from({ length: lanes }, () => runLane()));

    // A cancelled run is not a broken one. Every query aborts with zero results,
    // which walks straight into the total-failure branch below and reports
    // "Browser workers may be unavailable, DuckDuckGo is unreachable, or the
    // system is under extreme load" — an infrastructure outage the user never had.
    // They pressed Ctrl-C. Check this BEFORE the outage heuristic, and surface the
    // codebase's standard abort signature so the callers that already special-case
    // it (task-execution-service, the orchestrator, the CLI classifier) see a
    // cancellation rather than a failure.
    if (signal?.aborted) {
        throw new Error('Aborted');
    }

    // Detect total failure: if every valid query returned empty, the worker pool is likely dead.
    const totalResults = Array.from(resultMap.values()).reduce((sum, r) => sum + r.length, 0);
    if (totalResults === 0 && filteredQueries.length > 0) {
        metrics.increment('browser_search_total_failures_total', 1);
        
        let reason = `all ${filteredQueries.length} queries returned no results`;
        if (timeoutCount === filteredQueries.length) {
            reason = `all ${filteredQueries.length} queries timed out after ${QUERY_TIMEOUT_MS}ms`;
        } else if (errorCount === filteredQueries.length) {
            reason = `all ${filteredQueries.length} queries encountered worker errors`;
        } else if (timeoutCount + errorCount === filteredQueries.length) {
            reason = `${timeoutCount} queries timed out and ${errorCount} queries failed`;
        }

        throw new Error(
            `Search completely failed: ${reason}. ` +
            `Browser workers may be unavailable, DuckDuckGo is unreachable, or the system is under extreme load.` +
            (sampleWorkerError ? ` Last worker error: ${sampleWorkerError}` : '')
        );
    }

    const totalDuration = Date.now() - startTime;
    metrics.observe('browser_search_total_duration_ms', totalDuration);
    metrics.increment('browser_search_unique_urls_total', seenUrls.size);

    return resultMap;
}
