/**
 * Browser Error Utilities
 *
 * Error detection and circuit breaker utilities for browser operations.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import { CircuitBreaker } from '../../utils/circuit-breaker.ts';
import type { NodeError } from '../../types/index.ts';

/**
 * Check if an error is a transient socket error that can be retried.
 */
export function isTransientSocketError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('socket hang up') ||
        err.message.includes('EPIPE') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('timed out') ||
        err.message.includes('pool busy') ||
        err.message.includes('unreachable') ||
        // WorkerPoolManager throws this during the window between forceSchedulerRestart
        // clearing the scheduler reference and the old pool's 1500ms drain completing.
        // It is a transient state — retry after a short delay succeeds once drain finishes.
        err.message.includes('Worker pool is shutting down') ||
        // Poolifier throws this when pool.execute() is called while the pool is being
        // destroyed (e.g., during scheduler restart). Treat as transient — the pool will
        // be ready for new tasks once destruction completes and a new pool is initialized.
        err.message.includes('Cannot execute a task on destroying pool') ||
        err.message.includes('destroying pool') ||
        // The leader answered 503 because it is shutting down after losing
        // leadership. Retrying re-elects and reaches the new leader, so this is
        // transient in exactly the same sense as a pool drain.
        err.message.includes('Browser pool leader is draining')
    );
}

/**
 * Check if an error is a Cloudflare block/challenge error.
 * These are content-layer rejections, not infrastructure failures — they must NOT
 * count toward the circuit breaker failure threshold. Counting them caused the
 * breaker to open during normal searches and block all subsequent requests.
 */
export function isCloudflareBlockError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('Fetch blocked: Cloudflare') ||
        err.message.includes('Cloudflare challenge')
    );
}

/**
 * Check if an error is a task-level timeout (search/scrape/healthcheck timed out).
 * These indicate the remote site is slow or unresponsive — a normal occurrence during
 * a burst of 20 parallel queries. They must NOT trip the circuit breaker; only true
 * socket-layer infrastructure failures (ECONNREFUSED, ECONNRESET, etc.) should do so.
 */
export function isTaskTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('timed out after') ||
        err.message.includes('Search task timed out') ||
        err.message.includes('Scrape task timed out') ||
        err.message.includes('Health check timed out') ||
        err.message.includes('[BrowserClient] Request to')
    );
}

/**
 * Check if an error is a "leader is draining" rejection (HTTP 503 from
 * {@link BrowserServer.beginDrain}).
 *
 * The leader answers 503 while tearing down after losing leadership, so this is
 * an expected transition signal rather than a fault: the correct response is to
 * re-elect and retry against the new leader. It must not count toward the
 * circuit breaker — a leadership handover would otherwise look like a burst of
 * infrastructure failures and open the breaker for every subsequent request.
 */
export function isServerDrainingError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && err.message.includes('Browser pool leader is draining');
}

/**
 * Check if an error is specifically a pool-shutdown / pool-drain error.
 *
 * These are never counted against the circuit breaker: the pool recovers on its own.
 *
 * NOTE: this was once documented as "wait for the drain to finish and retry, NOT
 * forceSchedulerRestart". That is right only when the draining pool is *local*. In the
 * common case the pool belongs to another process — the elected leader — which is
 * exiting, so waiting alone leaves the cached client pointed at a dead port and the
 * retry fails identically (this cost whole search bursts; see the v1.1.0 changelog).
 * Recovery must also drop the cached scheduler handle so the next call re-resolves the
 * new leader; `recoverFromLeaderHandover` in task-execution-service.ts does exactly
 * that, using `forceSchedulerRestart(false)` whose liveness probe and in-progress guard
 * prevent the restart churn the old note was warning about.
 */
export function isPoolShutdownError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const err = error as NodeError;
    return typeof err.message === 'string' && (
        err.message.includes('Worker pool is shutting down') ||
        err.message.includes('Cannot execute a task on destroying pool') ||
        err.message.includes('destroying pool') ||
        // worker-pool-manager throws this when auto-recovery is still swapping the
        // pool. Its own text says "please retry", but until it was listed here no
        // classifier matched it, so the first attempt rethrew instead of retrying —
        // and auto-recovery fires only after 3 consecutive worker failures, i.e.
        // exactly when a burst of tasks is in flight and would all die together.
        err.message.includes('Worker pool is being reset') ||
        // poolifier's wording once destroy() has COMPLETED (vs "destroying pool"
        // while it is in progress). A queued closure holding a pool captured before
        // an auto-recovery destroy dispatches into exactly this window; it is the
        // same transient swap the "being reset" string covers, not a hard fault.
        err.message.includes('Cannot execute a task on not started pool')
    );
}

/**
 * A native addon that is missing or unloadable, i.e. a BROKEN INSTALL rather than
 * anything about the page, the network or the load on the machine.
 *
 * The case that produced this: npm 12 turns `allowScripts` OFF by default, so a
 * plain `npm install` no longer runs dependency lifecycle scripts — including the
 * one that fetches/builds `better-sqlite3`, which `camoufox-js` needs to launch a
 * browser at all. Every browser worker then dies with "Could not locate the
 * bindings file", every query fails, and the run reported that DuckDuckGo might be
 * unreachable or the machine under extreme load. Neither was true, and the advice
 * that follows from each is useless. An install fault has to say so.
 */
const NATIVE_BINDING_FAILURE =
  /Could not locate the bindings file|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|was compiled against a different Node\.js version|invalid ELF header|Cannot find module '[^']*\.node'/;

/** True when the failure is a missing/unloadable native addon — a broken install. */
export function isNativeBindingError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return NATIVE_BINDING_FAILURE.test(msg);
}

/** Playwright navigation failures whose cause is at the remote end — see below. */
const BENIGN_NAVIGATION_FAILURE =
  /page\.goto: (?:Timeout \d+ *ms exceeded|net::|NS_ERROR_|SEC_ERROR_|MOZILLA_PKIX_ERROR_)/;

/**
 * True when a scrape failure is an EXPECTED per-URL outcome rather than an engine
 * fault. Scraping the open web routinely hits bot-protection interstitials, thin
 * "stub" pages, HTTP 4xx/5xx, slow/unresponsive remotes, and (on quit) pool-drain
 * races. None of these is a pi-research bug: the URL is already accounted for as
 * "not scraped" (scrape_results_total{outcome=total_failure}) and surfaced to the
 * user that way, and no operator action follows. Callers use this to log such
 * failures at debug instead of error — keeping the ERROR log (and, via
 * logger.error's error-tracker re-track, the diagnostic error count) focused on
 * genuine faults. The messages matched here are produced by validateContent
 * (`Fetch blocked:` / `Fetch returned stub:`), scrapeWithFetch (`HTTP <code>`)
 * and extractPdfToMarkdown (`Could not extract content from PDF`, `PDF too
 * large`) — a malformed/encrypted/scanned-image-only PDF, or one that simply
 * exceeds the deliberate 100MB policy cap, is routine on the open web and
 * just as non-actionable as a stub page or a 404; the 25MB HTML policy caps
 * (`HTML response too large` from the fetch layer, `Browser HTML too large`
 * from the browser layer) are the same deliberate-cap class; the remaining
 * cases delegate to the shared browser-layer predicates. Deliberately does NOT
 * match 'PDF extraction unavailable' (a pdf-oxide-wasm native-module load
 * failure) — that is an infrastructure fault affecting every URL, not a
 * routine per-PDF outcome, and must still surface at ERROR.
 *
 * Navigation failures reported by Playwright (`page.goto: …`) are the same class
 * once — and only once — the reason is a network, TLS or timeout condition at the
 * remote end: an expired/self-signed certificate (`SEC_ERROR_UNKNOWN_ISSUER` on a
 * live university PDF host), a DNS or connection error (`net::ERR_…`,
 * `NS_ERROR_…`), or a site too slow to answer inside the scrape budget. These were
 * logged at ERROR by both the leader and the scraper. `page.goto` failures with any
 * OTHER reason — notably `Target closed`, which is how a crashed or force-closed
 * browser surfaces — are deliberately excluded and still report as faults.
 */
export function isBenignScrapeFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.startsWith('Fetch blocked:') ||                  // bot-protection interstitial (Cloudflare, DDoS-Guard, …)
    msg.startsWith('Fetch returned stub:') ||             // nav-only / near-empty page
    msg.startsWith('Could not extract content from PDF') || // malformed/encrypted/scanned-only PDF
    msg.startsWith('PDF too large') ||                    // exceeds the deliberate 100MB policy cap
    msg.startsWith('Unsupported download:') ||             // attachment-served non-PDF (zip/xlsx/…) — nothing to extract
    BENIGN_NAVIGATION_FAILURE.test(msg) ||                 // remote TLS/DNS/timeout — the URL could not be loaded
    msg.startsWith('HTML response too large') ||          // fetch-layer 25MB policy cap — same class as the PDF cap
    msg.startsWith('Browser HTML too large') ||           // browser-layer 25MB policy cap
    /^HTTP \d{3}\b/.test(msg) ||                          // remote 4xx/5xx status
    isCloudflareBlockError(error) ||
    isTaskTimeoutError(error) ||
    isPoolShutdownError(error)
  );
}

// Session-scoped circuit breaker storage to support concurrent research runs
const sessionCircuitBreakers = new Map<string, CircuitBreaker>();
// Hard cap so a cleanup path that ever skips clearSessionCircuitBreaker (e.g. an earlier
// throw in the cleanup closure) can't grow the map unboundedly over a long-lived TUI
// process with many sessions. Far above any realistic concurrent-session count. Mirrors
// the MAX_PATTERNS bound in error-tracker.ts.
const MAX_SESSION_BREAKERS = 256;

/**
 * Default circuit breaker configuration
 */
const DEFAULT_BREAKER_CONFIG: any = {
    // Raised from 3→8: parallel search bursts of 20 queries frequently produce
    // simultaneous timeouts on slow/CF-protected sites. A threshold of 3 caused
    // the breaker to open mid-burst, blocking all subsequent requests for the round.
    failureThreshold: 8,
    // Raised from 15s→45s: enough time for one full search burst + retry window
    // to complete before the breaker attempts to half-open.
    resetTimeoutMs: 45000,
    name: 'BrowserPool',
    isTransientError: (error: unknown) => {
        // Pool-drain transients: pool recovers on its own — don't count.
        if (isPoolShutdownError(error)) return false;
        // Leadership handover (503 draining) is a planned transition, not a
        // failure — counting it would open the breaker on every re-election.
        if (isServerDrainingError(error)) return false;
        // Cloudflare blocks are content-layer rejections, not infra failures — don't count.
        if (isCloudflareBlockError(error)) return false;
        // Task-level timeouts (slow/unresponsive sites) are expected during parallel
        // search bursts — don't count toward the circuit breaker threshold.
        if (isTaskTimeoutError(error)) return false;
        // Only genuine socket-layer failures (ECONNREFUSED, ECONNRESET, etc.) trip the circuit.
        return isTransientSocketError(error);
    }
};

/**
 * Get or create a session-scoped circuit breaker
 */
export function getBrowserCircuitBreaker(sessionId: string): CircuitBreaker {
    let breaker = sessionCircuitBreakers.get(sessionId);
    if (!breaker) {
        // Evict the oldest (insertion-order) entry when at the cap before inserting.
        if (sessionCircuitBreakers.size >= MAX_SESSION_BREAKERS) {
            const oldest = sessionCircuitBreakers.keys().next().value;
            if (oldest !== undefined) sessionCircuitBreakers.delete(oldest);
        }
        breaker = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, name: `BrowserPool-${sessionId}` });
        sessionCircuitBreakers.set(sessionId, breaker);
    }
    return breaker;
}

/**
 * Clear a session's circuit breaker
 */
export function clearSessionCircuitBreaker(sessionId: string): void {
    sessionCircuitBreakers.delete(sessionId);
}

/**
 * Global fallback circuit breaker — used when no sessionId is available.
 */
export const browserCircuitBreaker = new CircuitBreaker(DEFAULT_BREAKER_CONFIG);

/**
 * Reset all browser circuit breakers
 * Call this in test teardown/setup to prevent cross-test circuit state bleed.
 */
export function resetBrowserCircuitBreaker(sessionId?: string): void {
    if (sessionId) {
        clearSessionCircuitBreaker(sessionId);
    } else {
        sessionCircuitBreakers.clear();
        browserCircuitBreaker.reset();
    }
}
