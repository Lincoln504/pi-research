/**
 * Browser Manager
 *
 * HYBRID TASK SCHEDULER using FIXED CLUSTER POOL:
 * 1. Search Tasks: Offloaded to Poolifier Cluster Workers (Parallel Processes).
 *    Optimized for I/O performance and process isolation.
 * 2. Scrape Tasks: Managed in Main Thread (Shared Singleton Pool).
 *    Ensures precise coordination of the 3-batch protocol.
 * 
 * Implements hardware-aware concurrency and internal thread-health verification.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { FixedClusterPool, WorkerChoiceStrategies } from 'poolifier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    current = dirname(current);
  }
  return resolve(startDir, '../../');
}

const packageRoot = findPackageRoot(__dirname);
const browserCacheDir = join(packageRoot, '.browser');

// ============================================================================
// Global Concurrency & Pool State
// ============================================================================

const cpuCount = os.cpus().length;
const MAX_CONCURRENT_TASKS = Math.min(10, Math.max(1, cpuCount - 3));

interface ManagedBrowser {
    instance: any;
    linkScrapeCount: number;
    isHealthy: boolean;
}

const browserPool: ManagedBrowser[] = [];
const pendingLaunches = new Map<number, Promise<any>>();

/**
 * Task Performance Tracker
 */
const metrics = {
    search: { count: 0, totalDuration: 0 },
    scrape: { count: 0, totalDuration: 0 }
};

/**
 * High-Performance Scheduler
 */
class BrowserTaskScheduler {
    private pool: FixedClusterPool;
    private activeMainThreadCount = 0;
    private mainThreadQueue: { task: (browser: any) => Promise<any>, resolve: any, reject: any }[] = [];
    private lastSearchTimestamp = 0;
    private SEARCH_THROTTLE_MS = 3000; // Minimum 3s between any two searches globally

    constructor() {
        logger.log(`[Scheduler] Initializing FixedClusterPool (Size: ${MAX_CONCURRENT_TASKS})`);
        this.pool = new FixedClusterPool(MAX_CONCURRENT_TASKS, join(__dirname, 'worker.js'), {
            errorHandler: (e) => logger.error('[Scheduler] Cluster Error:', e),
            workerChoiceStrategy: WorkerChoiceStrategies.LEAST_USED,
            enableTasksQueue: true,
            tasksQueueOptions: {
                concurrency: 1 // Crucial: Each worker process handles only one task at a time
            }
        });
    }

    /**
     * Run Search via Cluster Worker (Process Isolation)
     */
    async runSearch(query: string): Promise<any> {
        // GLOBAL THROTTLE: Ensure we don't burst DDG too hard across workers
        const now = Date.now();
        const timeSinceLast = now - this.lastSearchTimestamp;
        if (timeSinceLast < this.SEARCH_THROTTLE_MS) {
            const delay = this.SEARCH_THROTTLE_MS - timeSinceLast;
            await new Promise(r => setTimeout(r, delay));
        }
        this.lastSearchTimestamp = Date.now();

        const result = (await this.pool.execute({ type: 'search', query })) as any;
        if (result.error) throw new Error(result.error);
        
        metrics.search.count++;
        metrics.search.totalDuration += result.duration;
        
        return result.results;
    }

    /**
     * Run Scrape via Main Thread (Shared handles)
     */
    async runScrape<T>(task: (browser: any) => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.mainThreadQueue.push({ task, resolve, reject });
            this.processMainThreadQueue();
        });
    }

    private async processMainThreadQueue() {
        if (this.activeMainThreadCount >= MAX_CONCURRENT_TASKS || this.mainThreadQueue.length === 0) return;
        
        this.activeMainThreadCount++;
        const item = this.mainThreadQueue.shift();
        if (!item) { this.activeMainThreadCount--; return; }
        const { task, resolve, reject } = item;
        
        const startTime = Date.now();
        try {
            const browser = await getCamoufoxBrowser();
            const mb = browserPool.find(b => b.instance === browser);
            if (!mb) throw new Error("Browser lost from pool.");

            if (mb.linkScrapeCount > 0 && mb.linkScrapeCount % 13 === 0) {
                const healthy = await performSearchHealthCheck(mb.instance);
                if (!healthy) {
                    mb.isHealthy = false;
                    throw new Error("Main thread browser failed health check.");
                }
            }

            const result = await task(mb.instance);
            mb.linkScrapeCount++;
            
            metrics.scrape.count++;
            metrics.scrape.totalDuration += (Date.now() - startTime);
            
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this.activeMainThreadCount--;
            this.processMainThreadQueue();
        }
    }

    getStats() {
        return {
            avgSearch: metrics.search.count ? (metrics.search.totalDuration / metrics.search.count).toFixed(2) : 0,
            avgScrape: metrics.scrape.count ? (metrics.scrape.totalDuration / metrics.scrape.count).toFixed(2) : 0,
            queueSize: this.mainThreadQueue.length
        };
    }

    async shutdown() {
        await this.pool.destroy();
    }
}

let scheduler: BrowserTaskScheduler | null = null;

function getScheduler(): BrowserTaskScheduler {
    if (!scheduler) scheduler = new BrowserTaskScheduler();
    return scheduler;
}

// ============================================================================
// Internal Search-based Quality Checks
// ============================================================================

const QUALITY_CHECK_QUERIES = [
    "latest space exploration news",
    "open source software development",
    "climate change mitigation strategies",
    "artificial intelligence ethics debate"
];

async function performSearchHealthCheck(browser: any): Promise<boolean> {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        const query = QUALITY_CHECK_QUERIES[Math.floor(Math.random() * QUALITY_CHECK_QUERIES.length)]!;
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.fill('input[name="q"]', query);
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.keyboard.press('Enter')
        ]);
        const count = await page.locator('a.result-link').count();
        return count > 0;
    } catch {
        return false;
    } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
    }
}

// ============================================================================
// Environment & Binary Management
// ============================================================================

function setupBrowserEnv() {
  if (!process.env['BROWSER_LOCAL_CONFIGURED']) {
    process.env['HOME'] = browserCacheDir;
    process.env['USERPROFILE'] = browserCacheDir;
    process.env['BROWSER_LOCAL_CONFIGURED'] = 'true';
  }
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

async function launchBrowserInstance(index: number): Promise<ManagedBrowser> {
  setupBrowserEnv();
  const { Camoufox } = require('camoufox-js');
  logger.log(`[Browser Manager] Launching browser instance #${index+1}...`);
  const browserInstance = await Camoufox({ headless: true, humanize: true });
  const isHealthy = await performSearchHealthCheck(browserInstance);
  return { instance: browserInstance, linkScrapeCount: 0, isHealthy };
}

export async function getCamoufoxBrowser(): Promise<any> {
  for (let i = browserPool.length - 1; i >= 0; i--) {
    const b = browserPool[i];
    if (b && (!b.instance.isConnected() || !b.isHealthy)) {
        if (b.instance.isConnected()) await b.instance.close().catch(() => {});
        browserPool.splice(i, 1);
    }
  }
  if (browserPool.length > 0) {
    const mb = browserPool[Math.floor(Math.random() * browserPool.length)];
    return mb ? mb.instance : browserPool[0]!.instance;
  }
  const MAX_PROCESSES = Math.min(3, MAX_CONCURRENT_TASKS);
  if (browserPool.length < MAX_PROCESSES) {
    const idx = browserPool.length;
    if (!pendingLaunches.has(idx)) {
        const p = launchBrowserInstance(idx).then(mb => {
            browserPool.push(mb);
            pendingLaunches.delete(idx);
            return mb.instance;
        });
        pendingLaunches.set(idx, p);
        return p;
    }
    return pendingLaunches.get(idx);
  }
  return browserPool[0]!.instance;
}

// ============================================================================
// Public Task Interface
// ============================================================================

export async function runBrowserTask<T>(task: (browser: any) => Promise<T>, type: 'search' | 'scrape' = 'scrape'): Promise<T> {
    if (type === 'search') {
        return getScheduler().runSearch((task as any).query) as any;
    }
    return getScheduler().runScrape(task);
}

export async function runWorkerSearch(query: string): Promise<any> {
    return getScheduler().runSearch(query);
}

export function getSchedulerStats() {
    return getScheduler().getStats();
}

export async function stopBrowserManager(): Promise<void> {
  if (scheduler) await scheduler.shutdown();
  await Promise.all(browserPool.map(mb => mb.instance.close().catch(() => {})));
  browserPool.length = 0;
}

shutdownManager.register(stopBrowserManager);
