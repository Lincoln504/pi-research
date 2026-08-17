/**
 * Browser Client for Remote Scheduler Communication
 *
 * HTTP client that communicates with a remote scheduler via HTTP.
 * Extracted from browser-manager.ts for better separation of concerns.
 */

import * as http from 'node:http';
import type { Config } from '../../config.ts';
import { getConfig } from '../../config.ts';

import type { SearchResult } from '../../web-research/types.ts';
import type { IScheduler, TaskDispatchListener } from '../../core/interfaces/scheduler-interfaces.ts';
import { logger } from '../../logger.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { redactSecrets } from '../../utils/log-utils.ts';
import { Utf8Body } from '../../utils/http-body.ts';
import { getClientAgent } from './client-agent.ts';
import { getHealthCheckBudgetMs } from './config.ts';
import type { NodeError } from '../../types/index.ts';

/**
 * Client-side patience margin on top of a leader budget that bounds the WHOLE
 * call (only the healthcheck does, now). The follower needs headroom for the HTTP
 * hop, so its own timer never answers first.
 */
const CLIENT_PATIENCE_MARGIN_MS = 15_000;

/**
 * Absolute ceiling on any follower request, so a wedged-but-listening leader
 * still fails in bounded time. Sits above the largest configurable leader budget
 * (120s nav + 120s task margin) plus the patience margin, so it only binds when
 * config is out of range. A DEAD leader is not this timer's job — its socket
 * fails fast with ECONNREFUSED/ECONNRESET.
 */
const CLIENT_TIMEOUT_CAP_MS = 300_000;


/** Fraction of the owning caller's budget at which the wedge detector fires, so the
 *  failure is reported and retriable inside the life of whatever asked for it. */
const OWNER_BUDGET_FRACTION = 0.8;

/**
 * Per-operation follower timeout.
 *
 * The rule this used to state — "the follower is at least as patient as the leader" —
 * is no longer the rule, and the change was deliberate; it is written out here because
 * it is the obvious thing to reach for and it is wrong for two of the three cases
 * below. What it replaced was worse still: a flat 60s that undercut the leader's
 * healthcheck budget (105s) and its config-driven search/scrape budgets (130s+ within
 * schema bounds), and whose message matches isTaskTimeoutError, so the retry gates
 * skipped it — long tasks failed client-side, unretried, while the leader was still
 * working on them.
 *
 * Search and scrape do not derive from the leader's TASK budget. That budget bounds
 * EXECUTION only — it is armed when the queue dispatches, not when the request
 * lands — so leader turnaround is queue wait plus that budget, and no value derived
 * from it alone can out-wait it. Deriving one anyway is how a follower came to
 * abandon requests the leader was still queueing, the same defect the leader-side
 * deadline had. This timer is a detector for a leader that is listening but no
 * longer answering; work waits, and is not discarded because the pool was busy.
 *
 * It is derived from the budget of whatever OWNS the call instead, because a
 * detector that fires after its caller is already dead detects nothing. The flat
 * 300s cap was exactly that: RESEARCHER_TIMEOUT_MS defaults to 300s and its schema
 * minimum is 180s, so the researcher holding the request was always killed first
 * and the user got a bare researcher timeout with nothing said about the browser
 * leader — where before they at least got a request-timeout they could classify
 * and retry. Firing at a fraction of the owner's budget leaves room for the
 * failure to be reported and retried within the life of the thing that asked.
 *
 * The healthcheck keeps a budget-derived value: its leader side bounds the WHOLE call,
 * wait included — the probe's wait timer rejects rather than queueing indefinitely — so
 * a liveness probe stays as impatient as a liveness probe should be. (It used to be
 * described as answering "healthy, saturated" instead of failing; that branch was
 * unreachable and has been removed. The bound is what matters here, not the verdict.)
 * Even there the old invariant is only conditional: at the schema's extreme settings
 * the derived leader budget exceeds the absolute cap, and the cap wins. That is the
 * intended order — five minutes is already far past the point where a liveness probe
 * tells anyone anything, whatever the leader is still doing.
 */
export function resolveClientRequestTimeoutMs(operation: string, config?: Config): number {
    switch (operation) {
        case 'search':
        case 'browser-task': {
            const ownerBudgetMs = (config ?? getConfig()).RESEARCHER_TIMEOUT_MS;
            return Math.min(CLIENT_TIMEOUT_CAP_MS, Math.floor(ownerBudgetMs * OWNER_BUDGET_FRACTION));
        }
        default:
            // healthcheck, plus any future/unknown path: the leader's own budget plus a
            // margin. Read from the SAME function the leader reads, not from a local
            // copy of the constant — the two were separate literals and would have
            // drifted the moment either moved, leaving the follower less patient than
            // the leader it is waiting on.
            return Math.min(CLIENT_TIMEOUT_CAP_MS, getHealthCheckBudgetMs(config) + CLIENT_PATIENCE_MARGIN_MS);
    }
}

/**
 * HTTP client that communicates with a remote scheduler.
 * Used when this process is not the leader.
 */
export class BrowserClient implements IScheduler {
    private readonly authSecret: string;

    /** The leader port this client was built for — lets the herd-guard cooldown
     * verify the cached handle still targets the REGISTERED leader, not a
     * predecessor that died inside the cooldown window. */
    get targetPort(): number {
        return this.port;
    }

    constructor(private readonly port: number, authSecret?: string) {
        this.authSecret = authSecret ?? process.env['PI_BROWSER_AUTH_SECRET'] ?? '';
        logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
    }

    private async request<T>(path: string, data: any, signal?: AbortSignal, config?: Config): Promise<T> {
        const start = Date.now();
        // Extract operation from path for error tracking
        const operation = path.includes('/search') ? 'search' :
                         path.includes('/scrape') ? 'browser-task' :
                         path.includes('/healthcheck') ? 'healthcheck' : 'network';

        return new Promise((resolve, reject) => {
            const agent = getClientAgent();
            // Wedge detector for search/scrape; leader budget + margin for the healthcheck.
            const timeoutMs = resolveClientRequestTimeoutMs(operation, config);
            let resolved = false;
            const controller = new AbortController();
            
            // Merge outer signal with our local controller
            let abortCleanup: (() => void) | undefined;
            if (signal) {
                if (signal.aborted) {
                    return reject(new Error('Aborted'));
                }
                const onAbort = () => {
                    if (resolved) return;
                    resolved = true;
                    controller.abort();
                    reject(new Error('Aborted'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }

            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    // Remove the outer-signal abort listener on timeout too. Without this,
                    // a long-lived run signal shared across many client requests accumulates
                    // one never-removed listener per timed-out request for the run's duration.
                    abortCleanup?.();
                    controller.abort();
                    const error = new Error(`[BrowserClient] Request to ${path} timed out after ${timeoutMs}ms (Shared queue may be deep)`);
                    errorTracker.trackError(error, {
                        component: 'browser-manager',
                        operation,
                        errorType: 'timeout',
                    });
                    reject(error);
                }
            }, timeoutMs);
            // FIX (#34): Don't keep the event loop alive for timeout timers
            if (timer.unref) timer.unref();

            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                agent,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    // FIX (#21): Send auth token to authenticate with browser server
                    'X-Browser-Auth': this.authSecret,
                }
            }, (res) => {
                // Do NOT clear the timeout/abort here. The response callback fires
                // when headers arrive, but the body is still streaming — clearing
                // now would let a stalled body hang forever and make an external
                // abort a no-op. Keep both armed until 'end' or 'error'.
                // This response carries scraped page content, so per-chunk decoding
                // would corrupt every non-ASCII page that exceeds one chunk. Collect
                // bytes and decode once. See Utf8Body.
                const collected = new Utf8Body();
                res.on('data', (chunk: Buffer) => collected.push(chunk));
                res.on('end', () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timer);
                    abortCleanup?.();
                    const duration = Date.now() - start;
                    try {
                        const parsed = JSON.parse(collected.toString());
                        if (res.statusCode === 503 && parsed?.error === 'draining') {
                            // Planned leadership handover, not a fault. Distinct message so
                            // isServerDrainingError can classify it: retry paths treat it as
                            // transient and the circuit breaker ignores it. Logged at DEBUG,
                            // not ERROR, so a routine re-election doesn't read as an incident.
                            // It is still recorded in the error tracker (this file records every
                            // non-200 uniformly) under its own `draining` errorType, which is
                            // what keeps handovers distinguishable from real 503s in forensics.
                            const error = new Error(
                                `Browser pool leader is draining (${parsed.reason || 'leadership-lost'}) — re-elect and retry`,
                            );
                            logger.debug(`[BrowserClient] Leader draining on ${path}; re-election required.`);
                            errorTracker.trackError(error, {
                                component: 'browser-manager',
                                operation,
                                errorType: 'draining',
                            });
                            reject(error);
                        } else if (res.statusCode !== 200) {
                            const error = new Error(parsed.error || `HTTP ${res.statusCode}`);
                            errorTracker.trackError(error, {
                                component: 'browser-manager',
                                operation,
                                errorType: 'http_error',
                            });
                            reject(error);
                        } else {
                            logger.debug(`[BrowserClient] Request ${path} completed in ${duration}ms`);
                            resolve(parsed);
                        }
                    } catch (_e) {
                        // FIX (#23): Truncate response body in error to prevent data leakage.
                        // Redact BEFORE truncating — slicing first can cut a secret-shaped
                        // token mid-way, leaving a fragment too short to be recognized.
                        const raw = redactSecrets(collected.toString());
                        const preview = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
                        const error = new Error(`Failed to parse response (status ${res.statusCode}): ${preview}`);
                        errorTracker.trackError(error, {
                            component: 'browser-manager',
                            operation,
                            errorType: 'parse_error',
                        });
                        reject(error);
                    }
                });
                res.on('error', (err) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timer);
                    abortCleanup?.();
                    const error = new Error(`[BrowserClient] Response stream error on ${path}: ${err.message}`);
                    errorTracker.trackError(error, {
                        component: 'browser-manager',
                        operation,
                        errorType: 'response_stream_error',
                    });
                    reject(error);
                });
            });

            req.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                abortCleanup?.();
                
                // If it's just a timeout abort error, the timer already rejected it.
                if (err.name === 'AbortError') return;
                // Enhance error message with socket-specific details
                const nodeErr = err as NodeError;
                let errorMsg: string;
                let errorType: string;
                if (nodeErr.code === 'ECONNRESET' || nodeErr.code === 'EPIPE') {
                    errorMsg = `Browser pool socket ${path} closed (pool likely busy or restarting) - ${err.message}`;
                    errorType = 'connection_reset';
                } else if (nodeErr.code === 'ECONNREFUSED') {
                    errorMsg = `Browser pool ${path} unreachable (server restarting or torn down) - ${err.message}`;
                    errorType = 'connection_refused';
                } else if (nodeErr.code === 'ETIMEDOUT') {
                    errorMsg = `Browser pool ${path} timed out (slow browser response) - ${err.message}`;
                    errorType = 'timeout';
                } else {
                    errorMsg = `Browser pool ${path} error: ${err.message}`;
                    errorType = 'unknown';
                }
                const error = new Error(errorMsg);
                logger.error(`[BrowserClient] Request to http://127.0.0.1:${this.port}${path} failed:`, errorMsg);
                errorTracker.trackError(error, {
                    component: 'browser-manager',
                    operation,
                    errorType,
                });
                reject(error);
            });
            req.write(JSON.stringify(data));
            req.end();
        });
    }

    /**
     * `onTaskEvent` is deliberately not invoked here. A follower sees only the
     * leader's final reply, never the moment the leader's queue hands the task to
     * a worker, so it has nothing truthful to report. Calling it on send would
     * arm the caller's guard against queue wait — precisely the bug being fixed —
     * so the caller's guard stays disarmed and this class bounds the call itself
     * (see resolveClientRequestTimeoutMs).
     */
    async runSearch(query: string, config?: Config, signal?: AbortSignal, _onTaskEvent?: TaskDispatchListener): Promise<SearchResult[]> {
        return this.request('/search', { query }, signal, config);
    }

    /** See runSearch on why `onTaskEvent` is not invoked. */
    async runScrape(url: string, config?: Config, signal?: AbortSignal, _onTaskEvent?: TaskDispatchListener): Promise<any> {
        return this.request('/scrape', { url }, signal, config);
    }

    async runHealthCheck(config?: Config, signal?: AbortSignal): Promise<{ success: boolean }> {
        return this.request('/healthcheck', {}, signal, config);
    }

    async shutdown() {
        // Clients don't shutdown the server
    }
}
