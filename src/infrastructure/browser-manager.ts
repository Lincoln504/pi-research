/**
 * Browser Manager
 *
 * Manages a global queue of browser tasks using poolifier for high-performance scheduling.
 * Implements hardware-aware concurrency and internal thread-health verification.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import { FixedThreadPool } from 'poolifier';
import { filterRelevantResults } from '../web-research/utils.ts';

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
 * Task Execution Logic using Poolifier patterns
 * Since Playwright handles are not serializable, we use Poolifier
 * to manage the "slots" while keeping the handles in the main thread.
 */
class BrowserTaskScheduler {
    private pool: FixedThreadPool;
    private activeCount = 0;
    private queue: { task: (browser: any) => Promise<any>, type: 'search' | 'scrape', resolve: any, reject: any }[] = [];

    constructor() {
        // We use Poolifier to manage the "concurrency slots" logically
        // even though the actual work happens via the browser handles.
        this.pool = new FixedThreadPool(MAX_CONCURRENT_TASKS, join(__dirname, 'worker.cjs'), {
            errorHandler: (e) => logger.error('[Scheduler] Pool Error:', e),
            onlineHandler: () => logger.debug('[Scheduler] Worker Online'),
        });
    }

    async run<T>(task: (browser: any) => Promise<T>, type: 'search' | 'scrape'): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ task, type, resolve, reject });
            this.process();
        });
    }

    private async process() {
        if (this.activeCount >= MAX_CONCURRENT_TASKS || this.queue.length === 0) return;
        
        this.activeCount++;
        const item = this.queue.shift();
        if (!item) { this.activeCount--; return; }
        const { task, type, resolve, reject } = item;
        
        try {
            const browser = await getCamoufoxBrowser();
            const mb = browserPool.find(b => b.instance === browser);
            
            if (!mb) throw new Error("Browser lost from pool.");

            // Health Check
            if (type === 'scrape' && mb.linkScrapeCount > 0 && mb.linkScrapeCount % 13 === 0) {
                const healthy = await performSearchHealthCheck(mb.instance);
                if (!healthy) {
                    mb.isHealthy = false;
                    throw new Error("Thread failed health check.");
                }
            }

            const result = await task(mb.instance);
            if (type === 'scrape') mb.linkScrapeCount++;
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this.activeCount--;
            this.process();
        }
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
        const testQueries = [...QUALITY_CHECK_QUERIES].sort(() => 0.5 - Math.random()).slice(0, 2);
        
        for (const query of testQueries) {
            await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.fill('input[name="q"]', query);
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                page.keyboard.press('Enter')
            ]);

            const results = await page.evaluate(() => {
                const doc = (globalThis as any).document;
                return Array.from(doc.querySelectorAll('a.result-link')).map((link: any) => ({
                    title: link.textContent?.trim() || '',
                    content: link.closest('tr')?.nextElementSibling?.querySelector('td.result-snippet')?.textContent?.trim() || ''
                }));
            });

            const relevant = filterRelevantResults(query, results as any);
            if (results.length === 0 || relevant.length === 0) return false;
        }
        return true;
    } catch {
        return false;
    } finally {
        await context.close().catch(() => {});
    }
}

// ============================================================================
// Browser Instance Management
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
  const browserInstance = await Camoufox({
    headless: true,
    humanize: true,
  });

  const isHealthy = await performSearchHealthCheck(browserInstance);
  
  return {
    instance: browserInstance,
    linkScrapeCount: 0,
    isHealthy
  };
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

export async function runBrowserTask<T>(task: (browser: any) => Promise<T>, type: 'search' | 'scrape' = 'scrape'): Promise<T> {
    return getScheduler().run(task, type);
}

export async function stopBrowserManager(): Promise<void> {
  if (scheduler) await scheduler.shutdown();
  await Promise.all(browserPool.map(mb => mb.instance.close().catch(() => {})));
  browserPool.length = 0;
}

shutdownManager.register(stopBrowserManager);
