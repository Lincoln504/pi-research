/**
 * Task Execution Service
 *
 * Handles task execution with retry logic and circuit breaker.
 * Refactored from browser-manager.ts for better separation of concerns.
 */

import type { Config } from '../../config.ts';
import type { SearchResult } from '../../web-research/types.ts';
import type { BrowserTask } from '../../types/index.ts';
import { logger } from '../../logger.ts';
import { redactSecrets } from '../../utils/log-utils.ts';
import { errorTracker } from '../../utils/error-tracker.ts';
import { getBrowserCircuitBreaker, browserCircuitBreaker, isTransientSocketError, isPoolShutdownError, isTaskTimeoutError, isCloudflareBlockError } from './browser-error-utils.ts';
import { getScheduler as _getScheduler, forceSchedulerRestart as _forceSchedulerRestart } from './scheduler-factory.ts';
import { waitForBrowserPoolIdle } from './browser-lifecycle.ts';
import { getServiceContainer, getService } from '../../core/service-registry.ts';
import type { ServiceContainer } from '../../core/service-registry.ts';
import { ServiceNames } from '../../core/service-interfaces.ts';
import type { ISchedulerFactory, IScheduler } from '../../core/scheduler-factory.ts';
import type { ISchedulerInternals, TaskDispatchListener } from '../../core/interfaces/scheduler-interfaces.ts';
import type { IStateManager } from '../../core/interfaces/state-manager-interfaces.ts';
import { BrowserClient } from './browser-client.ts';

// Cooldown to prevent cascading scheduler restarts (thundering herd)
let lastRestartTime = 0;
const RESTART_COOLDOWN_MS = 10000;

/**
 * Extra attempts reserved for a *leader handover* — the elected browser-pool leader
 * exiting while this process still has work in flight ("Worker pool is shutting
 * down" / "draining").
 *
 * This has its own budget because it is not a random socket blip: it is a known,
 * self-healing window that lasts as long as a fresh election takes (measured at
 * ~4 s on a loaded machine), and it hits *every* in-flight task of the affected
 * run at once. With only the single generic retry, a whole 20-query search burst
 * could be wiped out by one leader exiting — the run then failed outright with
 * "all N queries encountered worker errors", seconds before the new leader came up.
 * Spending these attempts is strictly cheaper than losing the run.
 */
const LEADER_HANDOVER_RETRIES = 3;
/** Backoff between handover attempts — long enough for an election to complete. */
const HANDOVER_BACKOFF_MS = 1200;

/**
 * A short, log-line-sized summary of an error — redacted BEFORE truncating.
 * A raw error.message can echo the failing URL verbatim (Playwright/undici
 * navigation errors routinely do), and a URL can carry userinfo credentials
 * (https://user:pass@host/...). Truncating first — the old `.substring(0,
 * 100)` at each call site below — can cut a credential mid-token, leaving a
 * short unredacted fragment in the log: redactSecrets' patterns need to see
 * the whole token to recognize it. Same class of bug as the truncate-before-
 * redact fix in log-utils.ts itself; redact the full message first here too.
 */
export function briefErrorMessage(error: unknown): string {
    const msg = error instanceof Error ? error.message : String(error);
    return redactSecrets(msg).substring(0, 100);
}

/**
 * Recover from a leader handover before retrying.
 *
 * Critically this DROPS the cached scheduler handle. A pool-shutdown error means
 * the leader we are connected to is going away, so the cached client points at a
 * corpse; simply waiting and retrying reconnects to the same dead port (observed
 * as a retry logging "Connecting to existing scheduler" with the *same* version id
 * and failing identically). Clearing it forces the next `getScheduler()` to
 * re-resolve — joining the new leader, or winning the election itself.
 *
 * `forceSchedulerRestart(false)` keeps its own liveness probe and in-progress
 * guard, so concurrent callers coalesce instead of stampeding.
 */
async function recoverFromLeaderHandover(container: ServiceContainer): Promise<void> {
    logger.warn('[BrowserManager] Leader handover detected (pool draining) — dropping stale scheduler handle and re-resolving...');
    await forceSchedulerRestart(false, container).catch((err) =>
        logger.debug('[BrowserManager] Scheduler re-resolve during handover failed (non-fatal):', err),
    );
    await waitForBrowserPoolIdle(15000).catch((err) =>
        logger.debug('Wait for browser idle timed out or failed:', err),
    );
}

/**
 * Is the leader currently registered in state still a live process — and is it
 * the one our cached handle actually targets?
 *
 * Used only to decide whether the restart cooldown below may be honoured.
 * Anything that prevents a confident "yes" (no registered leader, an unreadable
 * state file, a service-resolution failure, a cached client aimed at a different
 * port than the registered leader's) answers `false`, because the cost of an
 * unnecessary re-resolve is one cheap round-trip while the cost of skipping a
 * needed one is a task failure against a dead port.
 */
async function isRegisteredLeaderAliveUncached(container: ServiceContainer): Promise<boolean> {
    try {
        const stateManager = await getService<IStateManager>(ServiceNames.STATE_MANAGER, undefined, container);
        const info = await stateManager.getBrowserServer();
        if (!info) return false;
        // "Leader alive" is not enough: the cooldown protects the CACHED handle, so
        // that handle must also target the registered leader. If our leader B died
        // and another process already elected C, C is alive — but our cached client
        // still aims at B's dead port, and honouring the cooldown would leave every
        // retry failing against the corpse until the window expired.
        const schedulerService = await getService<ISchedulerInternals>(ServiceNames.SCHEDULER, undefined, container);
        const cached = schedulerService.getSchedulerInstance();
        if (cached instanceof BrowserClient && cached.targetPort !== info.port) return false;
        return await stateManager.isPidAlive(info.pid, info.schedulerId);
    } catch {
        return false;
    }
}

/**
 * Coalesce concurrent liveness probes.
 *
 * This runs on the failure path, where a whole query burst fails at once: a
 * 20-query search losing its leader calls it up to 19 times within milliseconds
 * (the first caller restarts and the rest land inside the cooldown). The probe is
 * cheap on Linux — a `/proc/<pid>/stat` read — but on Windows the PID-reuse guard
 * resolves the process start time by spawning `powershell -NoProfile`, so an
 * uncoalesced burst would fan out into ~19 concurrent PowerShell processes on the
 * slowest platform we support. The window is deliberately far shorter than
 * RESTART_COOLDOWN_MS: it exists to collapse one burst, not to cache a verdict.
 */
const LEADER_LIVENESS_COALESCE_MS = 1000;
let leaderLivenessProbe: { startedAt: number; result: Promise<boolean> } | null = null;

async function isRegisteredLeaderAlive(container: ServiceContainer): Promise<boolean> {
    const now = Date.now();
    if (leaderLivenessProbe && now - leaderLivenessProbe.startedAt < LEADER_LIVENESS_COALESCE_MS) {
        return leaderLivenessProbe.result;
    }
    const result = isRegisteredLeaderAliveUncached(container);
    leaderLivenessProbe = { startedAt: now, result };
    return result;
}

/**
 * Test seam: drop BOTH module-level globals that survive between tests — the
 * coalesced liveness probe (1s window) and the restart cooldown (10s window).
 *
 * Both are far longer than a test file's runtime, so a test that reaches
 * restartSchedulerWithHerdGuard leaves state that silently short-circuits the
 * next one: isRegisteredLeaderAliveUncached / forceSchedulerRestart simply are
 * not re-invoked. Today nothing observes that only because the one test that
 * reaches this path happens to run last — ordering, not a guarantee.
 */
export function _resetTaskExecutionGlobalsForTests(): void {
    leaderLivenessProbe = null;
    lastRestartTime = 0;
}

/**
 * Drop the scheduler handle and wait for the pool to settle, subject to a
 * cooldown that stops N concurrent task failures from each restarting.
 *
 * The cooldown is only safe while the registered leader is still alive: then the
 * cached handle points at a working process and skipping the restart costs
 * nothing. It is NOT safe when the leader is gone. A hard leader kill (SIGKILL,
 * OOM) surfaces to clients as ECONNREFUSED, which `isTransientSocketError`
 * matches but `isPoolShutdownError` does not — so it lands here rather than on
 * the handover path, and a bare wait leaves the cached client aimed at a corpse.
 * The retry then re-resolves to the same dead port and fails identically: the
 * exact stale-handle failure the leader-handover work fixed for the *graceful*
 * shutdown case. So the cooldown yields whenever the leader is not confirmed alive.
 */
async function restartSchedulerWithHerdGuard(container: ServiceContainer): Promise<void> {
    const now = Date.now();
    if (now - lastRestartTime > RESTART_COOLDOWN_MS || !(await isRegisteredLeaderAlive(container))) {
        lastRestartTime = now;
        logger.warn('[BrowserManager] Forcing scheduler restart and retrying...');
        await forceSchedulerRestart(false, container);
    } else {
        logger.warn('[BrowserManager] Scheduler restart triggered recently and the registered leader is still alive — waiting for pool idle instead...');
    }
    await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
}

/**
 * Get the scheduler from the factory, optionally using a specific container.
 */
async function getScheduler(config?: Config, container: ServiceContainer = getServiceContainer()): Promise<IScheduler> {
    try {
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY, undefined, container);
        return await factory.getScheduler(config);
    } catch {
        // Fallback to factory function if service resolution fails (e.g. during early init or tests)
        return await _getScheduler(config, container);
    }
}

/**
 * Force a scheduler restart, optionally using a specific container.
 */
async function forceSchedulerRestart(forceClearRemoteState: boolean = false, container: ServiceContainer = getServiceContainer()): Promise<void> {
    try {
        const factory = await getService<ISchedulerFactory>(ServiceNames.SCHEDULER_FACTORY, undefined, container);
        return await factory.forceSchedulerRestart(forceClearRemoteState);
    } catch {
        return await _forceSchedulerRestart(forceClearRemoteState, container);
    }
}

/**
 * Dispatches a browser task to the unified worker pool.
 */
export async function runBrowserTask<T>(
    taskOrUrl: string | BrowserTask,
    type: 'search' | 'scrape' = 'scrape',
    config?: Config,
    signal?: AbortSignal,
    retries = 1,
    container: ServiceContainer = getServiceContainer(),
    handoverRetries = LEADER_HANDOVER_RETRIES,
): Promise<T> {
    if (signal?.aborted) throw new Error('Aborted');

    // Extract sessionId for circuit breaker scoping
    const sessionId = typeof taskOrUrl === 'object' ? taskOrUrl.sessionId : undefined;
    const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;

    try {
        return await breaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config, container);
            if (type === 'search') {
                const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).query;
                if (!query) throw new Error('Search task requires a query');
                return (await scheduler.runSearch(query, config, signal)) as T;
            }

            const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).url;
            if (url) {
                return (await scheduler.runScrape(url, config, signal)) as T;
            }

            throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
        });
    } catch (error: unknown) {
        if (signal?.aborted || (error instanceof Error && error.message === 'Aborted')) throw new Error('Aborted', { cause: error });

        // A leader handover gets its own budget: it is a recoverable, seconds-long
        // window that strikes every in-flight task at once, so it must not be
        // charged against (or limited by) the single generic transient retry.
        const isHandover = isPoolShutdownError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error);
        if (isHandover && handoverRetries > 0) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: type,
                taskType: type,
                errorType: 'leader_handover',
            });
            logger.warn(`[BrowserManager] Leader handover during ${type} task (handover attempts left: ${handoverRetries}): ${briefErrorMessage(error)}...`);
            await recoverFromLeaderHandover(container);
            await new Promise((resolve) => setTimeout(resolve, HANDOVER_BACKOFF_MS + Math.floor(Math.random() * 400)));
            return runBrowserTask<T>(taskOrUrl, type, config, signal, retries, container, handoverRetries - 1);
        }

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: type,
                taskType: type,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during ${type} task (retries left: ${retries}): ${briefErrorMessage(error)}...`);

            if (isPoolShutdownError(error)) {
                // Handover budget already spent — fall back to a plain drain wait.
                logger.warn(`[BrowserManager] Pool is draining — waiting for pool idle before retry...`);
                await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
            } else {
                // True socket/connection error — restart the scheduler with thundering herd guard.
                // Do NOT force-clear remote leader state here: a transient socket
                // hiccup against a live-but-busy leader is not proof the leader is
                // dead. forceSchedulerRestart(false) still clears state when its own
                // PID+start-time liveness probe confirms the registered leader is
                // actually gone; it only skips clearing when that probe finds the
                // leader alive, which is exactly the case we must not disturb.
                await restartSchedulerWithHerdGuard(container);
            }

            // Retry with jitter (100-500ms) to prevent thundering herd
            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runBrowserTask<T>(taskOrUrl, type, config, signal, retries - 1, container, handoverRetries);
        }
        throw error;
    }
}

/**
 * Run a browser health check with retry logic.
 */
export async function runBrowserHealthCheck(config?: Config, retries = 1, signal?: AbortSignal, container: ServiceContainer = getServiceContainer()): Promise<{ success: boolean }> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config, container);
            return await scheduler.runHealthCheck(config, signal);
        });
    } catch (error: unknown) {
        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'healthcheck',
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during healthcheck (retries left: ${retries}): ${briefErrorMessage(error)}...`);

            if (isPoolShutdownError(error)) {
                // Same stale-handle trap as the task paths: waiting alone leaves the
                // cached client aimed at the departing leader, so the retry re-probes
                // a corpse and reports the pool unhealthy during a routine handover.
                await recoverFromLeaderHandover(container);
            } else {
                // See runBrowserTask: don't force-clear remote leader state on a bare
                // transient socket error — let the liveness probe inside
                // forceSchedulerRestart decide.
                await restartSchedulerWithHerdGuard(container);
            }

            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runBrowserHealthCheck(config, retries - 1, signal, container);
        }
        throw error;
    }
}

/**
 * Run a worker search query with retry logic.
 */
export async function runWorkerSearch(query: string, config?: Config, signal?: AbortSignal, retries = 1, sessionId?: string, container: ServiceContainer = getServiceContainer(), handoverRetries = LEADER_HANDOVER_RETRIES, onTaskEvent?: TaskDispatchListener): Promise<SearchResult[]> {
    if (signal?.aborted) throw new Error('Aborted');
    
    const breaker = sessionId ? getBrowserCircuitBreaker(sessionId) : browserCircuitBreaker;

    try {
        return await breaker.execute(async () => {
            if (signal?.aborted) throw new Error('Aborted');
            const scheduler = await getScheduler(config, container);
            return await scheduler.runSearch(query, config, signal, onTaskEvent);
        });
    } catch (error: unknown) {
        if (signal?.aborted || (error instanceof Error && error.message === 'Aborted')) throw new Error('Aborted', { cause: error });

        // See runBrowserTask: a leader handover wipes out an entire search burst at
        // once, so it gets its own attempts rather than the single generic retry.
        const isHandover = isPoolShutdownError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error);
        if (isHandover && handoverRetries > 0) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'search',
                query,
                errorType: 'leader_handover',
            });
            logger.warn(`[BrowserManager] Leader handover during search (handover attempts left: ${handoverRetries}): ${briefErrorMessage(error)}...`);
            await recoverFromLeaderHandover(container);
            await new Promise((resolve) => setTimeout(resolve, HANDOVER_BACKOFF_MS + Math.floor(Math.random() * 400)));
            return runWorkerSearch(query, config, signal, retries, sessionId, container, handoverRetries - 1, onTaskEvent);
        }

        if (retries > 0 && isTransientSocketError(error) && !isTaskTimeoutError(error) && !isCloudflareBlockError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'search',
                query,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during search (retries left: ${retries}): ${briefErrorMessage(error)}...`);

            if (isPoolShutdownError(error)) {
                await waitForBrowserPoolIdle(15000).catch((err) => logger.debug('Wait for browser idle timed out or failed:', err));
            } else {
                // See runBrowserTask: don't force-clear remote leader state on a bare
                // transient socket error — let the liveness probe inside
                // forceSchedulerRestart decide.
                await restartSchedulerWithHerdGuard(container);
            }

            const jitter = 100 + Math.floor(Math.random() * 400);
            await new Promise(resolve => setTimeout(resolve, jitter));
            return runWorkerSearch(query, config, signal, retries - 1, sessionId, container, handoverRetries, onTaskEvent);
        }
        throw error;
    }
}
