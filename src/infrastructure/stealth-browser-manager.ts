/**
 * Stealth Browser Manager
 *
 * Manages a global queue of browser tasks and a pool of Camoufox instances.
 * Ensures hardware-aware concurrency (CPUs - 3) is respected globally across 
 * all researchers and tool calls.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as os from 'node:os';

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

// Task Queue types
type BrowserTask<T> = (browser: any) => Promise<T>;
interface QueuedTask {
    execute: () => Promise<void>;
}

const taskQueue: QueuedTask[] = [];
let activeTaskCount = 0;

// Browser Pool state
const browserPool: any[] = [];
const pendingLaunches = new Map<number, Promise<any>>();
let camoufoxFetchAttempted = false;

logger.log(`[Stealth Manager] Global Concurrency initialized: ${MAX_CONCURRENT_TASKS} (Hardware: ${cpuCount} threads)`);

export function getGlobalConcurrencyLimit(): number {
  return MAX_CONCURRENT_TASKS;
}

// ============================================================================
// Environment & Binary Management
// = ============================================================================

function setupCamoufoxEnv() {
  if (!process.env['CAMOUFOX_LOCAL_CONFIGURED']) {
    const oldHome = process.env['HOME'];
    const oldUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = browserCacheDir;
    process.env['USERPROFILE'] = browserCacheDir;
    process.env['CAMOUFOX_LOCAL_CONFIGURED'] = 'true';
    return { oldHome, oldUserProfile };
  }
  return null;
}

const require = createRequire(import.meta.url);

/**
 * Check if camoufox-js is installed and binaries are ready.
 */
export function isCamoufoxAvailable(): boolean {
  try {
    const envState = setupCamoufoxEnv();
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

async function launchBrowserInstance(index: number): Promise<any> {
  const envState = setupCamoufoxEnv();
  try {
    const { Camoufox } = require('camoufox-js');
    if (envState) {
      if (envState.oldHome) process.env['HOME'] = envState.oldHome;
      if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
    }

    logger.log(`[Stealth Manager] Launching browser instance #${index+1}...`);
    const browser = await Camoufox({
      headless: true,
      humanize: true,
      // No resource blocking to avoid detection as requested
    });
    return browser;
  } catch (error) {
    if (envState) {
        if (envState.oldHome) process.env['HOME'] = envState.oldHome;
        if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
    }
    
    const msg = error instanceof Error ? error.message : String(error);
    if ((msg.includes('binaries not found') || msg.includes('not installed')) && !camoufoxFetchAttempted) {
        camoufoxFetchAttempted = true;
        logger.warn('[Stealth Manager] Binaries missing, fetching...');
        const { execSync } = await import('child_process');
        execSync('npx camoufox-js fetch', { 
          stdio: 'inherit',
          env: { ...process.env, HOME: browserCacheDir, USERPROFILE: browserCacheDir }
        });
        return launchBrowserInstance(index);
    }
    throw error;
  }
}

export async function getCamoufoxBrowser(): Promise<any> {
  // Clean dead
  for (let i = browserPool.length - 1; i >= 0; i--) {
    if (!browserPool[i].isConnected()) browserPool.splice(i, 1);
  }

  // Reuse existing
  if (browserPool.length > 0) {
    return browserPool[Math.floor(Math.random() * browserPool.length)];
  }

  // Scale if room (capped at 3 browsers to avoid overhead, but multiple pages per browser)
  const MAX_PROCESSES = Math.min(3, MAX_CONCURRENT_TASKS);
  const nextIndex = browserPool.length;
  
  if (nextIndex < MAX_PROCESSES) {
    if (!pendingLaunches.has(nextIndex)) {
        const p = launchBrowserInstance(nextIndex).then(b => {
            browserPool.push(b);
            pendingLaunches.delete(nextIndex);
            return b;
        }).catch(err => {
            pendingLaunches.delete(nextIndex);
            throw err;
        });
        pendingLaunches.set(nextIndex, p);
        return p;
    }
    return pendingLaunches.get(nextIndex);
  }

  return browserPool[0];
}

// Internal alias for the queue to use the same logic
const getBrowser = getCamoufoxBrowser;

// ============================================================================
// Global Task Queue Logic
// ============================================================================

/**
 * Run a browser task via the global concurrency queue.
 * This is the ONLY way to perform stealth browser operations.
 */
export async function runStealthTask<T>(task: BrowserTask<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const execute = async () => {
            activeTaskCount++;
            try {
                const browser = await getBrowser();
                const result = await task(browser);
                resolve(result);
            } catch (err) {
                reject(err);
            } finally {
                activeTaskCount--;
                processQueue();
            }
        };

        taskQueue.push({ execute });
        processQueue();
    });
}

function processQueue() {
    if (activeTaskCount >= MAX_CONCURRENT_TASKS || taskQueue.length === 0) {
        return;
    }

    const task = taskQueue.shift();
    if (task) {
        task.execute();
    }
}

// ============================================================================
// Cleanup
// ============================================================================

export async function stopStealthManager(): Promise<void> {
  if (browserPool.length > 0) {
    logger.log(`[Stealth Manager] Shutting down ${browserPool.length} browsers...`);
    await Promise.all(browserPool.map(b => b.close().catch(() => {})));
    browserPool.length = 0;
  }
}

shutdownManager.register(stopStealthManager);
