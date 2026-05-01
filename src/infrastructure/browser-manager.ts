import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { StateManager } from './state-manager.ts';
import { BrowserServer } from './browser-server.ts';
import { createRequire } from 'module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { FixedThreadPool, WorkerChoiceStrategies } from 'poolifier';
import type { SearchResult } from '../web-research/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const MAX_WORKERS = 3;

interface IScheduler {
    runSearch(query: string): Promise<SearchResult[]>;
    runScrape(url: string): Promise<any>;
    runHealthCheck(): Promise<{ success: boolean }>;
    shutdown(): Promise<void>;
}

class BrowserTaskScheduler implements IScheduler {
    private pool: FixedThreadPool;
    private server: BrowserServer | null = null;

    constructor() {
        logger.log(`[Scheduler] Initializing Unified FixedThreadPool (Size: ${MAX_WORKERS}) on PID ${process.pid}`);
        this.pool = new FixedThreadPool(MAX_WORKERS, join(__dirname, 'thread-worker.mjs'), {
            errorHandler: (e: Error) => logger.error('[Scheduler] Thread Error:', e),
            workerChoiceStrategy: WorkerChoiceStrategies.LEAST_USED,
            enableTasksQueue: true,
            tasksQueueOptions: { concurrency: 1 }
        });
    }

    async startServer(): Promise<number> {
        this.server = new BrowserServer({
            onSearch: (q) => this.runSearch(q),
            onScrape: (u) => this.runScrape(u),
            onHealthCheck: () => this.runHealthCheck(),
        });
        return this.server.start();
    }

    async runSearch(query: string): Promise<SearchResult[]> {
        const result = (await this.pool.execute({ type: 'search', query })) as { results: SearchResult[], error?: string };
        if (result.error) throw new Error(result.error);
        return result.results;
    }

    async runScrape(url: string): Promise<any> {
        const result = (await this.pool.execute({ type: 'scrape', url })) as any;
        if (result.error) throw new Error(result.error);
        return result;
    }

    async runHealthCheck(): Promise<{ success: boolean }> {
        const result = (await this.pool.execute({ type: 'healthcheck' })) as { success: boolean; error?: string };
        if (result.error) throw new Error(result.error);
        return result;
    }

    async shutdown() {
        if (this.server) await this.server.stop();
        await this.pool.destroy();
    }
}

class BrowserClient implements IScheduler {
    constructor(private port: number) {
        logger.log(`[BrowserClient] Connecting to global scheduler at http://127.0.0.1:${port}`);
    }

    private async request<T>(path: string, data: any): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                req.destroy();
                reject(new Error(`[BrowserClient] Request to ${path} timed out after 30s`));
            }, 30000);

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
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode !== 200) {
                            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
                        } else {
                            resolve(parsed);
                        }
                    } catch (e) {
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
    const existing = (globalThis as any).__PI_RESEARCH_SCHEDULER__;
    if (existing) return existing;

    if (initializationPromise) return initializationPromise;

    initializationPromise = (async () => {
        const stateManager = new StateManager();
        const serverInfo = await stateManager.getBrowserServer();

        // Fast path: an established leader is already running — connect as client
        if (serverInfo) {
            const isAlive = await stateManager.isPidAlive(serverInfo.pid);
            if (isAlive) {
                const client = new BrowserClient(serverInfo.port);
                (globalThis as any).__PI_RESEARCH_SCHEDULER__ = client;
                return client;
            }
            logger.warn(`[Scheduler] Detected dead leader (PID ${serverInfo.pid}), taking over...`);
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
                wonElection = true;
                return state;
            });
        } catch (error) {
            logger.error('[Scheduler] Failed to register as leader, running standalone:', error);
            (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
            return scheduler;
        }

        if (!wonElection) {
            logger.log(`[Scheduler] Lost election, connecting to winner at port ${winnerPort}`);
            await scheduler.shutdown();
            const client = new BrowserClient(winnerPort);
            (globalThis as any).__PI_RESEARCH_SCHEDULER__ = client;
            return client;
        }

        logger.log(`[Scheduler] Won election, serving as leader on port ${port} (PID ${process.pid})`);
        (globalThis as any).__PI_RESEARCH_SCHEDULER__ = scheduler;
        return scheduler;
    })();

    return initializationPromise;
}

const require = createRequire(import.meta.url);

export function isBrowserAvailable(): boolean {
  try {
    require.resolve('camoufox-js');
    return true;
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
