import { logger, getLogger } from '../logger.ts';
import { getSharedStateManager } from './state-manager.ts';
import { BrowserServer } from './browser-server.ts';
import { getBrowserEnv, ensureBrowserCacheDir, getCamoufoxBinaryPath } from './browser-config.ts';
import { createRequire } from 'node:module';
import { cleanupStaleProfiles } from './cleanup-utils.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { FixedClusterPool, WorkerChoiceStrategies } from 'poolifier';
import type { SearchResult } from '../web-research/types.ts';
import { getConfig, type Config } from '../config.ts';
import { CircuitBreaker } from '../utils/circuit-breaker.ts';
import { metrics } from '../utils/metrics.ts';
import {
  getSchedulerInstance,
  setScheduler,
  setSchedulerVersion,
  setSchedulerInitializationPromise,
  isSchedulerRestartInProgress,
  setSchedulerRestartInProgress,
} from '../core/internal-state.ts';
import type { NodeError, BrowserTask } from '../types/index.ts';
import { errorTracker } from '../utils/error-tracker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
        err.message.includes('unreachable')
    );
}

export const browserCircuitBreaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 15000,
    name: 'BrowserPool',
    isTransientError: isTransientSocketError
});

/**
 * Global HTTP Agent for high-concurrency client requests
 * 
 * IMPORTANT: The socket timeout must be longer than the BrowserClient request timeout (120s)
 * to prevent premature socket closure when the browser is slow or the queue is deep.
 */
const clientAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100, // Allow up to 100 concurrent requests to the leader
    maxFreeSockets: 10,
    // Set timeout to 180s (3x the client timeout) to handle slow browser responses
    // and prevent "socket hang up" errors during peak load
    timeout: 180000
});

/**
 * Generate a version hash for the scheduler based on critical config values.
 * This allows us to detect when configuration changes and invalidate the cache.
 */
function generateSchedulerVersion(config?: Config): string {
    const c = config || getConfig();
    const versionString = `v2:${c.WORKER_THREADS}:${c.MAX_CONCURRENT_RESEARCHERS}`;
    return crypto.createHash('sha256').update(versionString).digest('hex').substring(0, 16);
}

/**
 * Store the current scheduler version globally for quick invalidation checks.
 */
let cachedSchedulerVersion: string | null = null;

/**
 * Get the current number of worker threads from config.
 * This is a function instead of a constant to allow config changes to take effect
 * without requiring a process restart.
 */
export function getMaxWorkers(config?: Config): number {
    return (config || getConfig()).WORKER_THREADS;
}

/**
 * Get the current scheduler version hash.
 */
export function getSchedulerVersion(config?: Config): string {
    return generateSchedulerVersion(config);
}

/**
 * Get the global HTTP agent for client requests.
 * This is used by shutdownManager to properly destroy the agent on shutdown.
 */
export function getClientAgent(): http.Agent {
    return clientAgent;
}

/**
 * Force a restart of the scheduler by clearing the global cache and state.
 * This should be called when configuration changes are detected.
 */
export async function forceSchedulerRestart(forceClearRemoteState: boolean = false): Promise<void> {
    if (isSchedulerRestartInProgress()) {
        logger.log('[Scheduler] Restart already in progress, skipping concurrent call.');
        return;
    }
    setSchedulerRestartInProgress(true);
    try {
    logger.log('[Scheduler] Forcing scheduler restart due to config change...');

    // Grab the current scheduler BEFORE clearing the reference so we can
    // shut it down properly. Without this, the old scheduler's leadership-check
    // timer keeps firing for up to 60s after the restart, and its pool workers
    // keep running until the leadership loss is detected.
    const oldScheduler = getSchedulerInstance();

    // Clear cache immediately so new requests spawn a fresh scheduler.
    setScheduler(null);
    setSchedulerVersion(null);
    setSchedulerInitializationPromise(null);
    cachedSchedulerVersion = null;
    initializationPromise = null;

    // Find and clear any stale scheduler processes BEFORE clearing state.
    // Only clear if the registered PID is dead or belongs to this process — never
    // wipe state owned by a live remote leader (that would cause split-brain).
    const serverInfo = await getSharedStateManager().getBrowserServer();
    let shouldClearState = true;
    if (serverInfo) {
        const isAlive = await getSharedStateManager().isPidAlive(serverInfo.pid, serverInfo.schedulerId);
        if (isAlive && serverInfo.pid !== process.pid && !forceClearRemoteState) {
            logger.log(`[Scheduler] Skipping clearBrowserServer — live scheduler (PID ${serverInfo.pid}) owns state.`);
            shouldClearState = false;
        } else if (forceClearRemoteState) {
            logger.log(`[Scheduler] Force clearing remote state for PID ${serverInfo.pid} due to unreachability.`);
        }
    }

    if (shouldClearState) {
        await getSharedStateManager().clearBrowserServer().catch((error) => {
            logger.warn('[Scheduler] Failed to clear browser server from state:', error);
        });
    }

    // Shut down the old scheduler in the background so its timers and pool are
    // cleaned up promptly. Fire-and-forget: a restart means the caller already
    // triggered a retry, so we do not block on the old scheduler's teardown.
    if (oldScheduler instanceof BrowserTaskScheduler) {
        oldScheduler.shutdown().catch((err) => {
            logger.warn('[Scheduler] Error during old scheduler shutdown after restart:', err);
        });
    }

    logger.log('[Scheduler] Restart complete. Next call will create fresh scheduler.');
    } finally {
        setSchedulerRestartInProgress(false);
    }
}

interface IScheduler {
    runSearch(query: string, config?: Config): Promise<SearchResult[]>;
    runScrape(url: string, config?: Config): Promise<unknown>;
    runHealthCheck(config?: Config): Promise<{ success: boolean }>;
    shutdown(): Promise<void>;
}

class BrowserTaskScheduler implements IScheduler {
    private pool: any | null = null;
    private poolInitializationPromise: Promise<any> | null = null;
    private server: BrowserServer | null = null;
    private currentWorkerCount: number | null = null;
    private leadershipTimer: any = null;
    private consecutiveErrors: number = 0;
    private consecutiveLeadershipMisses: number = 0;
    private readonly LEADERSHIP_MISS_THRESHOLD: number = 5;
    private isShuttingDown: boolean = false;
    private readonly stateManager = getSharedStateManager();

    constructor(public readonly schedulerId: string) {
        // Pool initialization is deferred to first use via ensurePool()
        // This allows config changes to be detected and handled
        this.startLeadershipCheck();
    }

    private startLeadershipCheck() {
        if (this.leadershipTimer) return;
        this.leadershipTimer = setInterval(async () => {
            const serverInfo = await this.stateManager.getBrowserServer();
            // If the state file now points to a different schedulerId, we have lost leadership
            if (serverInfo?.schedulerId !== this.schedulerId) {
                this.consecutiveLeadershipMisses++;
                metrics.increment('browser_leadership_misses_total', 1);
                metrics.setGauge('browser_is_leader', 0);
                logger.warn(`[Scheduler] Leadership check failed (${this.consecutiveLeadershipMisses}/${this.LEADERSHIP_MISS_THRESHOLD}) - ID: ${this.schedulerId}, Current: ${serverInfo?.schedulerId}`);
                
                if (this.consecutiveLeadershipMisses >= this.LEADERSHIP_MISS_THRESHOLD) {
                    metrics.increment('browser_leadership_lost_total', 1);
                    logger.error(`[Scheduler] Leadership threshold exceeded (${this.consecutiveLeadershipMisses} misses), shutting down pool...`);
                    await this.shutdown();
                }
            } else {
                // Reset counter on successful leadership check
                if (this.consecutiveLeadershipMisses > 0) {
                    logger.log(`[Scheduler] Leadership confirmed, resetting miss counter from ${this.consecutiveLeadershipMisses}`);
                    this.consecutiveLeadershipMisses = 0;
                }
                metrics.setGauge('browser_is_leader', 1);
            }
            // Decay the consecutive error counter to allow recovery after transient errors
            if (this.consecutiveErrors > 0) {
                this.consecutiveErrors = Math.max(0, this.consecutiveErrors - 1);
            }
        }, 30000); // Check leadership every 30 seconds (reduced from 60s for faster failover)
        if (this.leadershipTimer.unref) this.leadershipTimer.unref();
    }

    private idleTimer: any = null;
    private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (reduced from 30m for efficiency)

    private resetIdleTimer() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            logger.log('[Scheduler] Browser pool idle timeout reached, shutting down...');
            this.shutdown();
        }, this.IDLE_TIMEOUT_MS);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    public resetIdleTimerOnActivity(): void {
        this.resetIdleTimer();
    }

    async startServer(): Promise<number> {
        this.server = new BrowserServer({
            onSearch: (q) => this.runSearch(q),
            onScrape: (u) => this.runScrape(u),
            onHealthCheck: () => this.runHealthCheck(),
        });
        return this.server.start();
    }

    /**
     * Ensure the pool is initialized with the current config.
     * Recreates the pool if the worker count has changed.
     */
    private async ensurePool(config?: Config): Promise<any> {
        this.resetIdleTimer();
        
        // Background cleanup of stale profiles (fire and forget)
        cleanupStaleProfiles().catch(() => {});

        const maxWorkers = getMaxWorkers(config);
        
        // If pool exists and worker count matches, return it immediately
        if (this.pool && this.currentWorkerCount === maxWorkers) {
            return this.pool;
        }

        // Use a promise to coalesce concurrent initialization calls
        if (this.poolInitializationPromise) {
            return this.poolInitializationPromise;
        }

        this.poolInitializationPromise = (async () => {
            try {
                if (this.pool && this.currentWorkerCount !== maxWorkers) {
                    logger.log(`[Scheduler] Worker count changed from ${this.currentWorkerCount} to ${maxWorkers}, recreating pool...`);
                    await this.pool.destroy();
                    this.pool = null;
                }
                
                this.currentWorkerCount = maxWorkers;
                
                logger.log(`[Scheduler] Initializing Unified FixedClusterPool (Size: ${maxWorkers}) on PID ${process.pid}`);
                
                ensureBrowserCacheDir();
                const browserEnv = getBrowserEnv();
                
                const logFilePath = getLogger().getLogFilePath();
                if (logFilePath) {
                    browserEnv['PI_RESEARCH_LOG_FILE'] = logFilePath;
                }

                const workerConcurrency = (config || getConfig()).WORKER_CONCURRENCY;
                this.pool = new FixedClusterPool(maxWorkers, join(__dirname, 'thread-worker.mjs'), {
                    env: browserEnv,
                    errorHandler: (e: Error) => {
                        this.consecutiveErrors++;
                        metrics.increment('browser_pool_errors_total', 1);
                        logger.error('[Scheduler] Cluster Error:', e);
                        if (this.consecutiveErrors >= 3) {
                            metrics.increment('browser_pool_unhealthy_events_total', 1);
                            logger.error(`[Scheduler] Worker pool may be unhealthy: ${this.consecutiveErrors} consecutive errors. Consider restarting.`);
                        }
                    },
                    workerChoiceStrategy: WorkerChoiceStrategies.ROUND_ROBIN,
                    enableTasksQueue: true,
                    tasksQueueOptions: {
                        concurrency: workerConcurrency, // configurable via PI_RESEARCH_WORKER_CONCURRENCY
                        taskStealing: true,
                        tasksStealingOnBackPressure: true
                    }
                });

                // Race check: if shutdown() was called while we were initializing the pool
                if (this.isShuttingDown) {
                    logger.warn('[Scheduler] Pool initialized but scheduler is already shutting down. Destroying...');
                    await this.pool.destroy().catch(() => {});
                    this.pool = null;
                    throw new Error('Scheduler is shutting down');
                }
                
                metrics.setGauge('browser_pool_workers', maxWorkers);
                metrics.increment('browser_pool_initializations_total', 1, { success: 'true' });
                
                return this.pool;
            } catch (error) {
                metrics.increment('browser_pool_initializations_total', 1, { success: 'false' });
                throw error;
            } finally {
                this.poolInitializationPromise = null;
            }
        })();

        return this.poolInitializationPromise;
    }

    async runSearch(query: string, config?: Config): Promise<SearchResult[]> {
        const pool = await this.ensurePool(config);
        const startTime = Date.now();
        
        // Worker does at most 2 page loads at 12s each; 30s gives a buffer without
        // blocking Promise.all for 2 minutes when DuckDuckGo is slow or Cloudflare blocks.
        const timeoutMs = 30000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Search task timed out after ${timeoutMs}ms`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: { results: SearchResult[], error?: string };
        try {
            result = await Promise.race([
                pool.execute({ type: 'search', query }),
                timeoutPromise
            ]) as { results: SearchResult[], error?: string };
        } catch (error) {
            metrics.increment('browser_search_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'search',
                query,
                taskType: 'search',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
        }
        
        const duration = Date.now() - startTime;
        metrics.observe('browser_search_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_search_requests_total', 1, { status: 'success' });
        logger.debug(`[Scheduler] Search task completed in ${duration}ms: ${query}`);
        if (result.error) {
            metrics.increment('browser_search_requests_total', 1, { status: 'error' });
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'search',
                query,
                taskType: 'search',
                errorType: 'search_error',
            });
            throw new Error(result.error);
        }
        this.consecutiveErrors = 0;
        return result.results;
    }

    async runScrape(url: string, config?: Config): Promise<any> {
        const pool = await this.ensurePool(config);
        const startTime = Date.now();
        const timeoutMs = 60000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Scrape task timed out after ${timeoutMs}ms`)), timeoutMs);
            if (timeoutId.unref) timeoutId.unref();
        });

        let result: any;
        try {
            result = await Promise.race([
                pool.execute({ type: 'scrape', url }),
                timeoutPromise
            ]);
        } catch (error) {
            metrics.increment('browser_scrape_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'browser-task',
                taskType: 'scrape',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
        }
        
        const duration = Date.now() - startTime;
        metrics.observe('browser_scrape_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_scrape_requests_total', 1, { status: 'success' });
        if (result.error) {
            metrics.increment('browser_scrape_requests_total', 1, { status: 'error' });
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'browser-task',
                taskType: 'scrape',
                errorType: 'scrape_error',
            });
            throw new Error(result.error);
        }
        this.consecutiveErrors = 0;
        return result;
    }

    async runHealthCheck(config?: Config): Promise<{ success: boolean }> {
        const pool = await this.ensurePool(config);
        const startTime = Date.now();
        const timeoutMs = 45000;
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        let result: { success: boolean; error?: string };
        try {
            result = await Promise.race([
                pool.execute({ type: 'healthcheck', queuedAt: startTime, taskTimeoutMs: timeoutMs }),
                timeoutPromise
            ]) as { success: boolean; error?: string };
        } catch (error) {
            metrics.increment('browser_healthcheck_errors_total', 1);
            errorTracker.trackError(error instanceof Error ? error : String(error), {
                component: 'browser-manager',
                operation: 'healthcheck',
                taskType: 'healthcheck',
            });
            throw error;
        } finally {
            clearTimeout(timeoutId!);
        }
        
        const duration = Date.now() - startTime;
        metrics.observe('browser_healthcheck_duration_ms', duration, { status: 'success' });
        metrics.increment('browser_healthcheck_requests_total', 1, { status: 'success' });
        metrics.setGauge('browser_pool_health', 1); // Health check passed
        logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
        if (result.error) {
            metrics.increment('browser_healthcheck_requests_total', 1, { status: 'error' });
            metrics.setGauge('browser_pool_health', 0); // Health check failed
            errorTracker.trackError(new Error(result.error), {
                component: 'browser-manager',
                operation: 'healthcheck',
                taskType: 'healthcheck',
                errorType: 'healthcheck_error',
            });
            throw new Error(result.error);
        }
        this.consecutiveErrors = 0;
        return result;
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }

        if (this.leadershipTimer) {
            clearInterval(this.leadershipTimer);
            this.leadershipTimer = null;
        }

        // Clear reference immediately to prevent new tasks from using this scheduler
        const currentScheduler = getSchedulerInstance();
        if (currentScheduler && 'schedulerId' in currentScheduler && currentScheduler.schedulerId === this.schedulerId) {
            setScheduler(null);
            setSchedulerVersion(null);
            setSchedulerInitializationPromise(null);
            cachedSchedulerVersion = null;
            initializationPromise = null;
        }

        const serverInfo = await this.stateManager.getBrowserServer();
        // Only clear state if this scheduler still owns it — same pid AND same schedulerId.
        // Checking pid alone is wrong when a new scheduler wins election in the same process:
        // the old scheduler's shutdown would wipe the new leader's registration.
        if (serverInfo?.pid === process.pid && serverInfo?.schedulerId === this.schedulerId) {
            await this.stateManager.clearBrowserServer().catch((err) => {
                logger.warn('[Scheduler] Failed to clear browser server state during shutdown:', err);
            });
        }

        if (this.server) {
            try {
                // Use a timeout for server shutdown
                await Promise.race([
                    this.server.stop(),
                    new Promise(resolve => setTimeout(resolve, 2000))
                ]);
            } catch (e) {
                logger.warn('[Scheduler] Server shutdown error:', e);
            }
            this.server = null;
        }

        if (this.pool) {
            try {
                // Use a timeout for pool destruction. Workers run async browser teardown
                // in their killHandler (context.close / browser.close via Playwright), so
                // allow enough time for those to complete before the IPC channel closes.
                await Promise.race([
                    this.pool.destroy(),
                    new Promise(resolve => setTimeout(resolve, 10000))
                ]);
            } catch (e) {
                logger.warn('[Scheduler] Pool destruction error:', e);
            }
            // Allow time for IPC channels and worker browser teardown to complete.
            // 200ms was insufficient: Playwright browser.close() in killed workers can
            // take >500ms, and a new pool started immediately could inherit a partially-
            // torn-down context.
            await new Promise(resolve => setTimeout(resolve, 1500));
            this.pool = null;

            // Clean up any orphaned Camoufox browser processes that may have been left behind
            // This handles edge cases where workers were force-killed or hung during teardown
            try {
                const { cleanupOrphanedCamoufoxProcesses } = await import('./browser-cleanup.ts');
                await cleanupOrphanedCamoufoxProcesses();
            } catch (cleanupError) {
                const msg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
                logger.warn('[Scheduler] Failed to cleanup orphaned browsers:', msg);
            }
        }
    }
}

class BrowserClient implements IScheduler {
    constructor(private port: number) {
        logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
    }

    private async request<T>(path: string, data: any): Promise<T> {
        const start = Date.now();
        // Extract operation from path for error tracking
        const operation = path.includes('/search') ? 'search' :
                         path.includes('/scrape') ? 'browser-task' :
                         path.includes('/healthcheck') ? 'healthcheck' : 'network';
        return new Promise((resolve, reject) => {
            // Increased timeout to 120s to allow for shared pool queuing delays
            const timeoutMs = 120000;
            let resolved = false;
            const controller = new AbortController();
            const timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
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

            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                agent: clientAgent, // Use high-concurrency agent
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                clearTimeout(timer);
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (resolved) return;
                    resolved = true;
                    const duration = Date.now() - start;
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode !== 200) {
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
                        const error = new Error(`Failed to parse response: ${body}`);
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
                // Enhance error message with socket-specific details
                const nodeErr = err as NodeError;
                let errorMsg: string;
                let errorType: string;
                if (nodeErr.code === 'ECONNRESET' || nodeErr.code === 'EPIPE') {
                    errorMsg = `Browser pool socket ${path} closed (pool likely busy or restarting) - ${err.message}`;
                    errorType = 'connection_reset';
                } else if (nodeErr.code === 'ECONNREFUSED') {
                    errorMsg = `Browser pool ${path} unreachable (server may have crashed) - ${err.message}`;
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

    async runSearch(query: string, _config?: Config): Promise<SearchResult[]> {
        return this.request('/search', { query });
    }

    async runScrape(url: string, _config?: Config): Promise<any> {
        return this.request('/scrape', { url });
    }

    async runHealthCheck(_config?: Config): Promise<{ success: boolean }> {
        return this.request('/healthcheck', {});
    }

    async shutdown() {
        // Clients don't shutdown the server
    }
}

let initializationPromise: Promise<IScheduler> | null = null;

async function getScheduler(config?: Config): Promise<IScheduler> {
    const currentVersion = generateSchedulerVersion(config);
    let existing = getSchedulerInstance();
    
    // Check if cached scheduler has different version (config changed)
    if (existing && cachedSchedulerVersion && cachedSchedulerVersion !== currentVersion) {
        logger.log(`[Scheduler] Config changed (old: ${cachedSchedulerVersion}, new: ${currentVersion}), forcing restart...`);
        await forceSchedulerRestart();
        existing = null; // Clear reference after restart
    }
    
    if (existing) {
        if (existing instanceof BrowserTaskScheduler) {
            existing.resetIdleTimerOnActivity();
        }
        return existing as IScheduler;
    }

    if (initializationPromise) return initializationPromise;

    let p: Promise<IScheduler>;
    
    const initializationFunction = async () => {
        const schedulerVersion = currentVersion;
        // Generate a unique ID for this scheduler instance to prevent PID reuse issues
        const schedulerId = crypto.randomUUID();
        
        const stateManager = getSharedStateManager();
        const serverInfo = await stateManager.getBrowserServer();
        
        // Race check: if another process won election while we were starting, serverInfo will be fresh
        // but our modules might have been reloaded.
        
        // Check if existing scheduler has different config version
        if (serverInfo) {
            const isAlive = await stateManager.isPidAlive(serverInfo.pid, serverInfo.schedulerId);
            if (isAlive) {
                // Get the stored version from state
                const state = await stateManager.readState();
                const storedVersion = state.schedulerVersion;
                
                // If version mismatch, we need to restart the scheduler
                if (storedVersion && storedVersion !== currentVersion) {
                    logger.log(`[Scheduler] Existing scheduler has stale config (old: ${storedVersion}, new: ${currentVersion}), forcing restart...`);
                    
                    if (serverInfo.pid !== process.pid) {
                        logger.log(`[Scheduler] Bypassing stale scheduler process (PID ${serverInfo.pid}) by clearing state...`);
                    }
                    
                    // Clear server info from state to force a restart
                    await stateManager.clearBrowserServer();
                    
                    // Fall through to start a new scheduler
                } else {
                    // Version matches, use existing scheduler
                    logger.log(`[Scheduler] Connecting to existing scheduler (version: ${currentVersion})`);
                    const client = new BrowserClient(serverInfo.port);
                    
                                // Race check: if initializationPromise was cleared (restart), don't set reference
                    if (initializationPromise === p) {
                        setScheduler(client);
                        setSchedulerVersion(currentVersion);
                        cachedSchedulerVersion = currentVersion;
                    } else {
                        logger.warn('[Scheduler] Initialization finished but was superseded by a restart. Disposing...');
                        await client.shutdown().catch(() => {});
                        throw new Error('Initialization superseded');
                    }
                    return client;
                }
            }
        }

        // Slow path: start a server then atomically claim leadership via compare-and-set.
        const scheduler = new BrowserTaskScheduler(schedulerId);
        let port: number;
        try {
            port = await scheduler.startServer();
        } catch (error) {
            logger.error('[Scheduler] Failed to start server, running standalone:', error);
            if (initializationPromise === p) {
                setScheduler(scheduler);
                setSchedulerVersion(currentVersion);
                cachedSchedulerVersion = currentVersion;
            } else {
                await scheduler.shutdown().catch(() => {});
                throw new Error('Initialization superseded', { cause: error });
            }
            return scheduler;
        }

        let wonElection = false;
        let winnerPort = port;
        try {
            await stateManager.updateState(async (state) => {
                if (state.browserServer) {
                    const alive = await stateManager.isPidAlive(state.browserServer.pid, state.browserServer.schedulerId, true);
                    if (alive) {
                        winnerPort = state.browserServer.port;
                        wonElection = false;
                        return state;
                    }
                }
                state.browserServer = { port, pid: process.pid, schedulerId };
                state.schedulerVersion = schedulerVersion; // Store current version in state
                wonElection = true;
                return state;
            });
        } catch (error) {
            logger.error('[Scheduler] Failed to register as leader, running standalone:', error);
            if (initializationPromise === p) {
                setScheduler(scheduler);
                setSchedulerVersion(currentVersion);
                cachedSchedulerVersion = currentVersion;
            } else {
                await scheduler.shutdown().catch(() => {});
                throw new Error('Initialization superseded', { cause: error });
            }
            return scheduler;
        }

        if (!wonElection) {
            logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
            await scheduler.shutdown();
            const client = new BrowserClient(winnerPort);
            if (initializationPromise === p) {
                setScheduler(client);
                setSchedulerVersion(schedulerVersion);
                cachedSchedulerVersion = schedulerVersion;
            } else {
                await client.shutdown().catch(() => {});
                throw new Error('Initialization superseded');
            }
            return client;
        }

        logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
        logger.log(`[Scheduler] Scheduler version: ${schedulerVersion}`);
        metrics.increment('browser_leadership_wins_total', 1);
        if (initializationPromise === p) {
            setScheduler(scheduler);
            setSchedulerVersion(schedulerVersion);
            cachedSchedulerVersion = schedulerVersion;
        } else {
            logger.warn('[Scheduler] Won election but was superseded by restart. Shutting down pool...');
            await scheduler.shutdown().catch(() => {});
            throw new Error('Initialization superseded');
        }
        return scheduler;
    };
    
    p = initializationFunction();
    initializationPromise = p;
    // Clear on rejection so the next caller retries rather than receiving the same
    // rejected promise forever.
    p.catch(() => {
        if (initializationPromise === p) initializationPromise = null;
    });
    return p;
}

// Export the getScheduler function for use by BrowserManagerService
export { getScheduler as _internalGetScheduler };

// Export getSchedulerVersion for use by BrowserManagerService
export { getSchedulerVersion as _internalGetSchedulerVersion, generateSchedulerVersion as _internalGenerateSchedulerVersion };

const require = createRequire(import.meta.url);

export function isBrowserAvailable(): boolean {
  try {
    require.resolve('camoufox-js');
    // Also check if the binary exists in the projected path
    return existsSync(getCamoufoxBinaryPath());
  } catch {
    return false;
  }
}

/**
 * Dispatches a browser task to the unified worker pool.
 */
export async function runBrowserTask<T>(taskOrUrl: string | BrowserTask, type: 'search' | 'scrape' = 'scrape', config?: Config, retries = 1): Promise<T> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config);
            if (type === 'search') {
                const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).query;
                if (!query) throw new Error('Search task requires a query');
                return (await scheduler.runSearch(query, config)) as T;
            }
            
            const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as BrowserTask).url;
            if (url) {
                return (await scheduler.runScrape(url, config)) as T;
            }

            throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
        });
    } catch (error: any) {
        if (retries > 0 && isTransientSocketError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: type,
                taskType: type,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during ${type} task (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
            await forceSchedulerRestart(true);
            // Add a small delay before retry to allow ports to free up
            await new Promise(resolve => setTimeout(resolve, 1000));
            return runBrowserTask<T>(taskOrUrl, type, config, retries - 1);
        }
        throw error;
    }
}

export async function runBrowserHealthCheck(config?: Config, retries = 1): Promise<{ success: boolean }> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config);
            return await scheduler.runHealthCheck(config);
        });
    } catch (error: any) {
        if (retries > 0 && isTransientSocketError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'healthcheck',
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during healthcheck (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
            await forceSchedulerRestart(true);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return runBrowserHealthCheck(config, retries - 1);
        }
        throw error;
    }
}

export async function runWorkerSearch(query: string, config?: Config, retries = 1): Promise<SearchResult[]> {
    try {
        return await browserCircuitBreaker.execute(async () => {
            const scheduler = await getScheduler(config);
            return await scheduler.runSearch(query, config);
        });
    } catch (error: any) {
        if (retries > 0 && isTransientSocketError(error)) {
            errorTracker.trackError(error, {
                component: 'browser-manager',
                operation: 'search',
                query,
                errorType: 'transient_socket_error',
            });
            logger.warn(`[BrowserManager] Transient socket error during search (retries left: ${retries}): ${error.message.substring(0, 100)}...`);
            logger.warn(`[BrowserManager] Forcing scheduler restart and retrying...`);
            await forceSchedulerRestart(true);
            await new Promise(resolve => setTimeout(resolve, 1000));
            return runWorkerSearch(query, config, retries - 1);
        }
        throw error;
    }
}

export async function stopBrowserManager(): Promise<void> {
  browserCircuitBreaker.reset();
  metrics.increment('browser_manager_shutdowns_total', 1);
  const globalScheduler = getSchedulerInstance();
  // Clear both references before any async work so concurrent getScheduler()
  // calls during shutdown see null and start fresh rather than receiving a
  // scheduler that is mid-teardown.
  setScheduler(null);
  setSchedulerInitializationPromise(null);
  initializationPromise = null;

  if (globalScheduler instanceof BrowserTaskScheduler) {
      // Do not call clearBrowserServer() here — BrowserTaskScheduler.shutdown() already
      // does it with the proper pid+schedulerId dual-check to avoid wiping state owned
      // by a newer scheduler that won election in the same process.
      await globalScheduler.shutdown();
  }

  // Destroy the keep-alive HTTP agent so its open sockets don't block process exit.
  clientAgent.destroy();
}
