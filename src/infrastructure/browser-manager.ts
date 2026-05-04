import { logger, getLogger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { StateManager } from './state-manager.ts';
import { BrowserServer } from './browser-server.ts';
import { getBrowserEnv, ensureBrowserCacheDir, getCamoufoxBinaryPath } from './browser-config.ts';
import { createRequire } from 'module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { FixedThreadPool, FixedClusterPool, WorkerChoiceStrategies } from 'poolifier';
import type { SearchResult } from '../web-research/types.ts';
import { getConfig, type Config } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Global HTTP Agent for high-concurrency client requests
 */
const clientAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100, // Allow up to 100 concurrent requests to the leader
    maxFreeSockets: 10,
    timeout: 60000
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
 * Force a restart of the scheduler by clearing the global cache and state.
 * This should be called when configuration changes are detected.
 */
export async function forceSchedulerRestart(): Promise<void> {
    logger.log('[Scheduler] Forcing scheduler restart due to config change...');
    
    // Clear global cache
    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
    cachedSchedulerVersion = null;
    initializationPromise = null;
    
    // Clear browser server from state
    const stateManager = new StateManager();
    await stateManager.clearBrowserServer().catch((error) => {
        logger.warn('[Scheduler] Failed to clear browser server from state:', error);
    });
    
    // Find and kill any stale scheduler processes
    const serverInfo = await stateManager.getBrowserServer();
    if (serverInfo) {
        const isAlive = await stateManager.isPidAlive(serverInfo.pid);
        if (isAlive && serverInfo.pid !== process.pid) {
            try {
                logger.log(`[Scheduler] Terminating stale scheduler process (PID ${serverInfo.pid})...`);
                process.kill(serverInfo.pid, 'SIGTERM');
                // Give it a moment to shutdown gracefully
                await new Promise<void>(resolve => setTimeout(resolve, 500));
            } catch (error) {
                logger.warn('[Scheduler] Failed to terminate stale scheduler:', error);
            }
        }
    }
    
    logger.log('[Scheduler] Restart complete. Next call will create fresh scheduler.');
}

interface IScheduler {
    runSearch(query: string, config?: Config): Promise<SearchResult[]>;
    runScrape(url: string, config?: Config): Promise<any>;
    runHealthCheck(config?: Config): Promise<{ success: boolean }>;
    shutdown(): Promise<void>;
}

class BrowserTaskScheduler implements IScheduler {
    private pool: any | null = null;
    private poolInitializationPromise: Promise<any> | null = null;
    private server: BrowserServer | null = null;
    private currentWorkerCount: number | null = null;

    constructor() {
        // Pool initialization is deferred to first use via ensurePool()
        // This allows config changes to be detected and handled
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

                this.pool = new FixedClusterPool(maxWorkers, join(__dirname, 'thread-worker.mjs'), {
                    env: browserEnv,
                    errorHandler: (e: Error) => logger.error('[Scheduler] Cluster Error:', e),
                    workerChoiceStrategy: WorkerChoiceStrategies.ROUND_ROBIN,
                    enableTasksQueue: true,
                    tasksQueueOptions: {
                        concurrency: 2, // 2 concurrent tasks per process; each gets its own page, safe for parallel I/O
                        taskStealing: true,
                        tasksStealingOnBackPressure: true
                    }
                });
                
                return this.pool;
            } finally {
                this.poolInitializationPromise = null;
            }
        })();

        return this.poolInitializationPromise;
    }

    async runSearch(query: string, config?: Config): Promise<SearchResult[]> {
        const pool = await this.ensurePool(config);
        const startTime = Date.now();
        
        // Add a 120s timeout to pool execution to prevent orchestration hangs
        const timeoutMs = 120000;
        const result = await Promise.race([
            pool.execute({ type: 'search', query }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Search task timed out after ${timeoutMs}ms`)), timeoutMs))
        ]) as { results: SearchResult[], error?: string };
        
        const duration = Date.now() - startTime;
        logger.debug(`[Scheduler] Search task completed in ${duration}ms: ${query}`);
        if (result.error) throw new Error(result.error);
        return result.results;
    }

    async runScrape(url: string, config?: Config): Promise<any> {
        const pool = await this.ensurePool(config);
        const timeoutMs = 120000;
        const result = await Promise.race([
            pool.execute({ type: 'scrape', url }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Scrape task timed out after ${timeoutMs}ms`)), timeoutMs))
        ]) as any;
        if (result.error) throw new Error(result.error);
        return result;
    }

    async runHealthCheck(config?: Config): Promise<{ success: boolean }> {
        const pool = await this.ensurePool(config);
        const startTime = Date.now();
        const timeoutMs = 30000;
        const result = await Promise.race([
            pool.execute({ type: 'healthcheck' }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Health check timed out after ${timeoutMs}ms`)), timeoutMs))
        ]) as { success: boolean; error?: string };
        const duration = Date.now() - startTime;
        logger.debug(`[Scheduler] Healthcheck completed in ${duration}ms`);
        if (result.error) throw new Error(result.error);
        return result;
    }

    async shutdown() {
        if (this.server) await this.server.stop();
        if (this.pool) await this.pool.destroy();
        this.pool = null;
    }
}

class BrowserClient implements IScheduler {
    constructor(private port: number) {
        logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
    }

    private async request<T>(path: string, data: any): Promise<T> {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            // Increased timeout to 120s to allow for shared pool queuing delays
            const timeoutMs = 120000;
            const timer = setTimeout(() => {
                req.destroy();
                reject(new Error(`[BrowserClient] Request to ${path} timed out after ${timeoutMs}ms (Shared queue may be deep)`));
            }, timeoutMs);

            const req = http.request({
                hostname: '127.0.0.1',
                port: this.port,
                path,
                method: 'POST',
                agent: clientAgent, // Use high-concurrency agent
                headers: { 'Content-Type': 'application/json' }
            }, (res) => {
                clearTimeout(timer);
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const duration = Date.now() - start;
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode !== 200) {
                            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                        } else {
                            logger.debug(`[BrowserClient] Request ${path} completed in ${duration}ms`);
                            resolve(parsed);
                        }
                    } catch (_e) {
                        reject(new Error(`Failed to parse response: ${body}`));
                    }
                });
            });

            req.on('error', (err) => {
                clearTimeout(timer);
                logger.error(`[BrowserClient] Request to http://127.0.0.1:${this.port}${path} failed:`, err);
                reject(err);
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
    let existing = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    
    // Check if cached scheduler has different version (config changed)
    if (existing && cachedSchedulerVersion && cachedSchedulerVersion !== currentVersion) {
        logger.log(`[Scheduler] Config changed (old: ${cachedSchedulerVersion}, new: ${currentVersion}), forcing restart...`);
        await forceSchedulerRestart();
        existing = null; // Clear reference after restart
    }
    
    if (existing) return existing;

    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        const schedulerVersion = currentVersion;
        const stateManager = new StateManager();
        const serverInfo = await stateManager.getBrowserServer();
        
        // Check if existing scheduler has different config version
        if (serverInfo) {
            const isAlive = await stateManager.isPidAlive(serverInfo.pid);
            if (isAlive) {
                // Get the stored version from state
                const state = await stateManager.readState();
                const storedVersion = state.schedulerVersion;
                
                // If version mismatch, we need to restart the scheduler
                if (storedVersion && storedVersion !== currentVersion) {
                    logger.log(`[Scheduler] Existing scheduler has stale config (old: ${storedVersion}, new: ${currentVersion}), forcing restart...`);
                    
                    // Terminate the old scheduler process
                    try {
                        if (serverInfo.pid !== process.pid) {
                            process.kill(serverInfo.pid, 'SIGTERM');
                            await new Promise<void>(resolve => setTimeout(resolve, 1000));
                        }
                    } catch (error) {
                        logger.warn('[Scheduler] Failed to terminate stale scheduler:', error);
                    }
                    
                    // Clear server info from state to force a restart
                    await stateManager.clearBrowserServer();
                    
                    // Fall through to start a new scheduler
                } else {
                    // Version matches, use existing scheduler
                    logger.log(`[Scheduler] Connecting to existing scheduler (version: ${currentVersion})`);
                    const client = new BrowserClient(serverInfo.port);
                    (globalThis as any).__PI_RESEARCH_SCHEDULER__ = client;
                    cachedSchedulerVersion = currentVersion;
                    return client;
                }
            }
        }

        // Slow path: start a server then atomically claim leadership via compare-and-set.
        const scheduler = new BrowserTaskScheduler();
        let port: number;
        try {
            port = await scheduler.startServer();
        } catch (error) {
            logger.error('[Scheduler] Failed to start server, running standalone:', error);
            (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
            cachedSchedulerVersion = currentVersion;
            return scheduler;
        }

        let wonElection = false;
        let winnerPort = port;
        try {
            await stateManager.updateState(async (state) => {
                if (state.browserServer) {
                    const alive = await stateManager.isPidAlive(state.browserServer.pid);
                    if (alive) {
                        winnerPort = state.browserServer.port;
                        wonElection = false;
                        return state;
                    }
                }
                state.browserServer = { port, pid: process.pid };
                state.schedulerVersion = schedulerVersion; // Store current version in state
                wonElection = true;
                return state;
            });
        } catch (error) {
            logger.error('[Scheduler] Failed to register as leader, running standalone:', error);
            (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
            cachedSchedulerVersion = currentVersion;
            return scheduler;
        }

        if (!wonElection) {
            logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
            await scheduler.shutdown();
            const client = new BrowserClient(winnerPort);
            (globalThis as any).__PI_RESEARCH_SCHEDULER__ = client;
            cachedSchedulerVersion = schedulerVersion;
            return client;
        }

        logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
        logger.log(`[Scheduler] Scheduler version: ${schedulerVersion}`);
        (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
        cachedSchedulerVersion = schedulerVersion;
        return scheduler;
    })();

    return initializationPromise;
}

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
export async function runBrowserTask<T>(taskOrUrl: any, type: 'search' | 'scrape' = 'scrape', config?: Config): Promise<T> {
    const scheduler = await getScheduler(config);
    if (type === 'search') {
        const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).query;
        return (await scheduler.runSearch(query, config)) as any;
    }
    
    const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).url;
    if (url) {
        return (await scheduler.runScrape(url, config)) as any;
    }

    throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
}

export async function runBrowserHealthCheck(config?: Config): Promise<{ success: boolean }> {
    const scheduler = await getScheduler(config);
    return scheduler.runHealthCheck(config);
}

export async function runWorkerSearch(query: string, config?: Config): Promise<SearchResult[]> {
    const scheduler = await getScheduler(config);
    return scheduler.runSearch(query, config);
}

export async function stopBrowserManager(): Promise<void> {
  const globalScheduler = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
  // Clear both references before any async work so concurrent getScheduler()
  // calls during shutdown see null and start fresh rather than receiving a
  // scheduler that is mid-teardown.
  (globalThis as any).__PI_RESEARCH_SCHEDULER__ = null;
  initializationPromise = null;

  if (globalScheduler instanceof BrowserTaskScheduler) {
      const stateManager = new StateManager();
      const serverInfo = await stateManager.getBrowserServer();
      if (serverInfo?.pid === process.pid) {
          await stateManager.clearBrowserServer();
      }
      await globalScheduler.shutdown();
  }
}

shutdownManager.register(stopBrowserManager);
