/**
 * Browser Manager
 *
 * Manages a global queue of browser tasks and a pool of Camoufox instances.
 * Implements hardware-aware concurrency and internal thread-health verification.
 * 
 * DISTINCTION:
 * - Search: Finding links (via DuckDuckGo Lite).
 * - Scrape: Extracting content from specific URLs (HTML or PDF).
 * 
 * INTERNAL QUALITY CHECKS:
 * Every browser thread is verified using SEARCH tests:
 * 1. On Launch: 2 test searches must pass.
 * 2. Periodic: After every 13 links scraped, 2 test searches must pass.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
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
// Global Concurrency & Queue State
// ============================================================================

const cpuCount = os.cpus().length;
const MAX_CONCURRENT_TASKS = Math.min(10, Math.max(1, cpuCount - 3));

type BrowserTask<T> = (browser: any) => Promise<T>;
interface QueuedTask {
    type: 'search' | 'scrape';
    execute: () => Promise<void>;
}

const taskQueue: QueuedTask[] = [];
let activeTaskCount = 0;

// Browser Pool state
interface ManagedBrowser {
    instance: any;
    linkScrapeCount: number; // Counter for scraping tasks only
    isHealthy: boolean;
}

const browserPool: ManagedBrowser[] = [];
const pendingLaunches = new Map<number, Promise<any>>();

logger.log(`[Browser Manager] Global Concurrency initialized: ${MAX_CONCURRENT_TASKS} (Hardware: ${cpuCount} threads)`);

export function getGlobalConcurrencyLimit(): number {
  return MAX_CONCURRENT_TASKS;
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

/**
 * Performs 2 random searches to verify the thread isn't blocked by the engine.
 * This is a "search-based health check" used to validate the thread's scraping ability.
 */
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
            if (results.length === 0 || relevant.length === 0) {
                logger.error(`[Browser Manager] Search Health Check FAILED for: "${query}". Thread is blocked.`);
                return false;
            }
        }
        
        logger.log('[Browser Manager] ✓ Thread Search Health Check Passed.');
        return true;
    } catch (e) {
        logger.error('[Browser Manager] Search Health Check CRASHED:', e);
        return false;
    } finally {
        await context.close().catch(() => {});
    }
}

// ============================================================================
// Environment & Binary Management
// ============================================================================

function setupBrowserEnv() {
  if (!process.env['BROWSER_LOCAL_CONFIGURED']) {
    const oldHome = process.env['HOME'];
    const oldUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = browserCacheDir;
    process.env['USERPROFILE'] = browserCacheDir;
    process.env['BROWSER_LOCAL_CONFIGURED'] = 'true';
    return { oldHome, oldUserProfile };
  }
  return null;
}

const require = createRequire(import.meta.url);

export function isBrowserAvailable(): boolean {
  try {
    const envState = setupBrowserEnv();
    require.resolve('camoufox-js');
    if (envState) {
      if (envState.oldHome) process.env['HOME'] = envState.oldHome;
      if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
    }
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Browser Instance Management
// ============================================================================

async function launchBrowserInstance(index: number): Promise<ManagedBrowser> {
  const envState = setupBrowserEnv();
  try {
    const { Camoufox } = require('camoufox-js');
    if (envState) {
      if (envState.oldHome) process.env['HOME'] = envState.oldHome;
      if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
    }

    logger.log(`[Browser Manager] Launching browser instance #${index+1}...`);
    const browserInstance = await Camoufox({
      headless: true,
      humanize: true,
    });

    // Mandatory Launch Health Check (2 searches)
    const isHealthy = await performSearchHealthCheck(browserInstance);
    
    return {
      instance: browserInstance,
      linkScrapeCount: 0,
      isHealthy
    };
  } catch (error) {
    if (envState) {
        if (envState.oldHome) process.env['HOME'] = envState.oldHome;
        if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
    }
    throw error;
  }
}

export async function getCamoufoxBrowser(): Promise<any> {
  // Clean dead
  for (let i = browserPool.length - 1; i >= 0; i--) {
    const b = browserPool[i];
    if (b && (!b.instance.isConnected() || !b.isHealthy)) {
        if (b.instance.isConnected()) await b.instance.close().catch(() => {});
        browserPool.splice(i, 1);
    }
  }

  // Reuse existing
  if (browserPool.length > 0) {
    const b = browserPool[Math.floor(Math.random() * browserPool.length)];
    if (b) return b.instance;
  }

  // Scale if room
  const MAX_PROCESSES = Math.min(3, MAX_CONCURRENT_TASKS);
  const nextIndex = browserPool.length;
  
  if (nextIndex < MAX_PROCESSES) {
    if (!pendingLaunches.has(nextIndex)) {
        const p = launchBrowserInstance(nextIndex).then(mb => {
            browserPool.push(mb);
            pendingLaunches.delete(nextIndex);
            return mb.instance;
        }).catch(err => {
            pendingLaunches.delete(nextIndex);
            throw err;
        });
        pendingLaunches.set(nextIndex, p);
        return p;
    }
    return pendingLaunches.get(nextIndex);
  }

  const b = browserPool[0];
  if (b) return b.instance;
  
  const firstPending = pendingLaunches.values().next().value;
  if (firstPending) return firstPending;

  throw new Error("Browser Pool Exhausted.");
}

export const getBrowser = getCamoufoxBrowser;

// ============================================================================
// Global Task Queue Logic
// ============================================================================

export async function runBrowserTask<T>(task: BrowserTask<T>, type: 'search' | 'scrape' = 'scrape'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const execute = async () => {
            activeTaskCount++;
            try {
                await getCamoufoxBrowser();
                const mb = browserPool[Math.floor(Math.random() * browserPool.length)];
                
                if (!mb) throw new Error("No browser available.");

                // PERIODIC SEARCH-BASED HEALTH CHECK: Every 13 links scraped, do 2 test searches
                if (type === 'scrape' && mb.linkScrapeCount > 0 && mb.linkScrapeCount % 13 === 0) {
                    const healthy = await performSearchHealthCheck(mb.instance);
                    if (!healthy) {
                        mb.isHealthy = false;
                        throw new Error("Thread failed periodic search health check.");
                    }
                }

                const result = await task(mb.instance);
                if (type === 'scrape') mb.linkScrapeCount++;
                
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                activeTaskCount--;
                processQueue();
            }
        };

        taskQueue.push({ type, execute });
        processQueue();
    });
}

function processQueue() {
    if (activeTaskCount >= MAX_CONCURRENT_TASKS || taskQueue.length === 0) return;
    const task = taskQueue.shift();
    if (task) task.execute();
}

export async function stopBrowserManager(): Promise<void> {
  if (browserPool.length > 0) {
    logger.log(`[Browser Manager] Shutting down ${browserPool.length} browsers...`);
    await Promise.all(browserPool.map(mb => {
        if (mb && mb.instance) return mb.instance.close().catch(() => {});
        return Promise.resolve();
    }));
    browserPool.length = 0;
  }
}

shutdownManager.register(stopBrowserManager);
