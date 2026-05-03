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
import { FixedThreadPool, WorkerChoiceStrategies } from 'poolifier';
import type { SearchResult } from '../web-research/types.ts';
import { getConfig } from '../config.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Generate a version hash for the scheduler based on critical config values.
 * This allows us to detect when configuration changes and invalidate the cache.
 */
function generateSchedulerVersion(): string {
    const config = getConfig();
    const versionString = `v1:${config.WORKER_THREADS}:${config.MAX_CONCURRENT_RESEARCHERS}`;
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
export function getMaxWorkers(): number {
    return getConfig().WORKER_THREADS;
}

/**
 * Get the current scheduler version hash.
 */
export function getSchedulerVersion(): string {
    return generateSchedulerVersion();
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
    runSearch(query: string): Promise<SearchResult[]>;
    runScrape(url: string): Promise<any>;
    runHealthCheck(): Promise<{ success: boolean }>;
    shutdown(): Promise<void>;
}

class BrowserTaskScheduler implements IScheduler {
    private pool: FixedThreadPool | null = null;
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
    private async ensurePool(): Promise<FixedThreadPool> {
        const maxWorkers = getMaxWorkers();
        
        // If pool doesn't exist or worker count changed, recreate it
        if (!this.pool || this.currentWorkerCount !== maxWorkers) {
            if (this.pool && this.currentWorkerCount !== maxWorkers) {
                logger.log(`[Scheduler] Worker count changed from ${this.currentWorkerCount} to ${maxWorkers}, recreating pool...`);
                await this.pool.destroy();
            }
            
            this.currentWorkerCount = maxWorkers;
            const oldPool = this.pool;
            
            logger.log(`[Scheduler] Initializing Unified FixedThreadPool (Size: ${maxWorkers}) on PID ${process.pid}`);
            
            // Ensure browser cache directory exists and get environment variables for redirection
            ensureBrowserCacheDir();
            const browserEnv = getBrowserEnv();
            
            // Pass the log file path to workers so they can log to the same file
            const logFilePath = getLogger().getLogFilePath();
            if (logFilePath) {
                browserEnv['PI_RESEARCH_LOG_FILE'] = logFilePath;
            }

            this.pool = new FixedThreadPool(maxWorkers, join(__dirname, 'thread-worker.mjs'), {
                env: browserEnv,
                errorHandler: (e: Error) => logger.error('[Scheduler] Thread Error:', e),
                workerChoiceStrategy: WorkerChoiceStrategies.LEAST_USED,
                enableTasksQueue: true,
                tasksQueueOptions: { 
                    concurrency: maxWorkers, // Allow tasks to be dequeued in parallel up to worker count
                    taskStealing: true,
                    tasksStealingOnBackPressure: true
                }
            });
            
            // If we replaced an old pool, we're done
            if (oldPool) {
                return this.pool;
            }
        }
        
        return this.pool;
    }

    async runSearch(query: string): Promise<SearchResult[]> {
        const pool = await this.ensurePool();
        const startTime = Date.now();
        const result = (await pool.execute({ type: 'search', query })) as { results: SearchResult[], error?: string };
        const duration = Date.now() - startTime;
        logger.debug(`[Scheduler] Search task completed in ${duration}ms: ${query}`);
        if (result.error) throw new Error(result.error);
        return result.results;
    }

    async runScrape(url: string): Promise<any> {
        const pool = await this.ensurePool();
        const result = (await pool.execute({ type: 'scrape', url })) as any;
        if (result.error) throw new Error(result.error);
        return result;
    }

    async runHealthCheck(): Promise<{ success: boolean }> {
        const pool = await this.ensurePool();
        const startTime = Date.now();
        const result = (await pool.execute({ type: 'healthcheck' })) as { success: boolean; error?: string };
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

    async runSearch(query: string): Promise<SearchResult[]> {
        return this.request('/search', { query });
    }

    async runScrape(url: string): Promise<any> {
        return this.request('/scrape', { url });
    }

    async runHealthCheck(): Promise<{ success: boolean }> {
        return this.request('/healthcheck', {});
    }

    async shutdown() {
        // Clients don't shutdown the server
    }
}

let initializationPromise: Promise<IScheduler> | null = null;

async function getScheduler(): Promise<IScheduler> {
    const currentVersion = generateSchedulerVersion();
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
        const schedulerVersion = generateSchedulerVersion(); // Unique name to avoid shadowing
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
        // Two processes that concurrently reach this point will both start a server, but
        // only the one that wins the file-lock race will keep it; the loser shuts down
        // its server and connects as a client to the winner.
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
        (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
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
export async function runBrowserTask<T>(taskOrUrl: any, type: 'search' | 'scrape' = 'scrape'): Promise<T> {
    const scheduler = await getScheduler();
    if (type === 'search') {
        const query = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).query;
        return (await scheduler.runSearch(query)) as any;
    }
    
    const url = typeof taskOrUrl === 'string' ? taskOrUrl : (taskOrUrl as any).url;
    if (url) {
        return (await scheduler.runScrape(url)) as any;
    }

    throw new Error('Unified browser manager requires data-driven tasks (URLs/Queries)');
}

export async function runBrowserHealthCheck(): Promise<{ success: boolean }> {
    const scheduler = await getScheduler();
    return scheduler.runHealthCheck();
}

export async function runWorkerSearch(query: string): Promise<SearchResult[]> {
    const scheduler = await getScheduler();
    return scheduler.runSearch(query);
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
