/**
 * Web Research Extension - Browser-based Search (DuckDuckGo Lite)
 * 
 * Orchestrates exhaustive search bursts across multiple worker processes.
 */

import { runWorkerSearch } from '../infrastructure/browser/task-execution-service.ts';
import { getMaxWorkers, COLD_START_ALLOWANCE_MS } from '../infrastructure/browser/config.ts';
import { isTaskTimeoutError, isNativeBindingError } from '../infrastructure/browser/browser-error-utils.ts';
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
    // The budget mirrors the scheduler's own task ceiling in
    // BrowserTaskScheduler.runSearch (= SEARCH_TIMEOUT_MS + BROWSER_TASK_TIMEOUT_MS +
    // COLD_START_ALLOWANCE_MS) so this layer never preempts the worker's deadline with
    // a shorter one.
    //
    // Both clocks now start at DISPATCH (see startQueryDeadline below), which is
    // what makes mirroring the value correct. While this one started at enqueue,
    // equal values meant the two raced and whichever fired first reported — which
    // is why the same starvation shows up in the logs under two different messages
    // on different days. The earlier response to that was to widen this budget
    // (nav plus a margin) so a queued query could still use its full nav budget
    // once picked up. That treats the symptom: a margin only buys one extra
    // query's worth of wait, and a burst four times the pool's reach exhausts any
    // constant. Measuring execution instead of waiting is the fix; the sum
    // survives as the budget because a search legitimately costs nav plus overhead.
    //
    // COLD_START_ALLOWANCE_MS is part of the sum for the same reason it is part of
    // the scheduler's own ceiling: the first query dispatched to a freshly created or
    // just-reset worker pays a real browser launch + context creation inline before
    // any navigation starts, and this layer's budget must not fire before the
    // scheduler's own (correct, larger) deadline gets a chance to.
    const QUERY_TIMEOUT_MS = (config?.SEARCH_TIMEOUT_MS ?? 45_000) + (config?.BROWSER_TASK_TIMEOUT_MS ?? 10_000) + COLD_START_ALLOWANCE_MS;

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
        // Armed by onDispatch below — when the browser queue hands this query to a
        // worker — not here. Arming here charged queue wait to the query's budget, so
        // a burst larger than the pool could serve inside one budget killed its own
        // tail: every query enqueued in the same millisecond, and 90s later the ones
        // still waiting aborted together having done no work. Measured at 78 of 100.
        // The scheduler owns the execution deadline; this is the caller-side mirror of
        // it, and against a follower scheduler — which cannot observe leader dispatch
        // and so never calls onDispatch — it stays disarmed and the client's own
        // bound applies instead.
        let timeoutId: NodeJS.Timeout | undefined;
        const onTaskEvent = (event: 'dispatched' | 'settled') => {
            // Disarm on every event, so the clock only ever runs while a worker is
            // actually holding this query. Arming alone was not enough: retries inside
            // runWorkerSearch dispatch AGAIN, and between a failed attempt and its
            // redispatch there is a backoff sleep, a re-enqueue and a fresh queue wait.
            // A timer left running across that gap aborts the retry for its
            // predecessor's overrun, and reports it as "the browser pool was
            // saturated" — the same charge-the-wait-to-the-work mistake, one attempt
            // removed.
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = undefined;
            if (event !== 'dispatched') return;
            timeoutId = setTimeout(() => timeoutController.abort(), QUERY_TIMEOUT_MS);
            safeUnref(timeoutId);
        };

        try {
            if (signal?.aborted) {
                resultMap.set(query, []);
                return;
            }

            const querySignal = signal
              ? AbortSignal.any([signal, timeoutController.signal])
              : timeoutController.signal;

            const results = await runWorkerSearch(query, config, querySignal, 1, sessionId, container, undefined, onTaskEvent);
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
            // Two clocks can end this query, and only one of them used to be recognised.
            // The scheduler's own execution deadline is armed in the same synchronous
            // block as this layer's guard, with the SAME duration derived from the same
            // two config values — so on the leader path the scheduler's timer is always
            // registered first, always fires first, and its rejection clears this layer's
            // timer before Node ever reaches it. `timeoutController.signal.aborted` was
            // therefore false for every real search timeout in the leader path.
            //
            // The consequences all pointed the wrong way: the query was logged at ERROR,
            // counted as `status=error`, and reported to the researcher as "an
            // infrastructure failure" — while `timeoutCount` stayed at zero, making the
            // whole-burst timeout attribution below unreachable. A task timeout is a
            // timeout whichever clock names it.
            const isTimeout = (timeoutController.signal.aborted || isTaskTimeoutError(error))
                && !signal?.aborted;
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
    // A lane only picks up its next query when the previous one finishes, so the shared
    // queue never builds a backlog and every query eventually runs. The burst takes longer
    // in wall-clock terms; it no longer discards most of itself to get there.
    //
    // Lanes are not what makes a query's deadline honest — dispatch-armed timers do that,
    // at both this layer and the scheduler's, and they hold no matter how deep the queue
    // gets. Lanes remain because bounding depth is worth having on its own: the pool is
    // shared with scrapes and healthchecks and with other concurrent runs, and a burst that
    // dumps its whole plan into the queue delays all of them.
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

        // A missing native addon is a BROKEN INSTALL, and the generic advice below
        // actively misleads: it sends the reader to check their network and their
        // machine load when neither is involved and neither can be acted on. npm 12
        // defaults `allowScripts` to off, so a plain install no longer builds
        // camoufox-js's better-sqlite3 dependency and every browser worker dies
        // identically. Say that instead, and say what fixes it.
        if (isNativeBindingError(sampleWorkerError)) {
            metrics.increment('browser_search_total_failures_total', 1, { cause: 'native_binding' });
            throw new Error(
                `Search completely failed: ${reason}, all with a missing native module. ` +
                `This is an incomplete install, not a network problem: the browser engine's ` +
                `native dependencies were never built. npm 12 does not run dependency install ` +
                `scripts by default — reinstall allowing them (npm install @lincoln504/pi-research ` +
                `--allow-scripts, or npm approve-scripts --allow-scripts-pending), then retry.` +
                (sampleWorkerError ? ` Last worker error: ${sampleWorkerError}` : '')
            );
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
