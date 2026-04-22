/**
 * Camoufox Browser Lifecycle Manager
 *
 * Manages a pool of Camoufox (anti-detect Firefox) instances for stealth scraping.
 * Reuses browser processes across sessions to minimize overhead while supporting
 * high concurrency across multiple processes.
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

/**
 * Robustly find the package root by looking for package.json.
 */
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
// Browser Pool Module State
// ============================================================================

/**
 * SMART CONCURRENCY:
 * Calculate max pool size based on available CPU threads.
 * Rule: total threads - 3 (to leave room for the OS and the main process).
 * Minimum: 1, Maximum: 10 (to avoid IP rate limits).
 */
const cpuCount = os.cpus().length;
const MAX_POOL_SIZE = Math.min(10, Math.max(1, cpuCount - 3));

const browserPool: any[] = [];
let launchLock: Promise<any> | null = null;
let camoufoxFetchAttempted = false;

/**
 * Export the calculated concurrency limit for other modules to use.
 */
export function getRecommendedConcurrency(): number {
  return MAX_POOL_SIZE;
}

/**
 * Configure environment for local Camoufox storage.
 */
function setupCamoufoxEnv() {
  if (!process.env['CAMOUFOX_LOCAL_CONFIGURED']) {
    const oldHome = process.env['HOME'];
    const oldUserProfile = process.env['USERPROFILE'];

    process.env['HOME'] = browserCacheDir;
    process.env['USERPROFILE'] = browserCacheDir;
    process.env['CAMOUFOX_LOCAL_CONFIGURED'] = 'true';
    
    logger.debug(`[Camoufox] Environment temporarily redirected to local directory: ${browserCacheDir}`);
    
    return { oldHome, oldUserProfile };
  }
  return null;
}

const require = createRequire(import.meta.url);

/**
 * Check if camoufox-js is installed
 */
function isCamoufoxAvailable(): boolean {
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

/**
 * Get a browser from the pool or launch a new one.
 * Implements a simple round-robin / load-balancing strategy.
 */
export async function getCamoufoxBrowser(): Promise<any> {
  // Log configuration on first access
  if (browserPool.length === 0 && !launchLock) {
    logger.log(`[Camoufox] Smart Concurrency: ${cpuCount} threads detected. Max pool size: ${MAX_POOL_SIZE}`);
  }

  // 1. Clean up stale/disconnected browsers
  for (let i = browserPool.length - 1; i >= 0; i--) {
    if (!browserPool[i].isConnected()) {
      browserPool.splice(i, 1);
    }
  }

  // 2. If we have a healthy browser and haven't hit the pool limit, 
  // we might still want to return an existing one to save resources.
  if (browserPool.length > 0) {
    // Return a random browser from the pool to distribute load
    return browserPool[Math.floor(Math.random() * browserPool.length)];
  }

  // 3. Coalesce concurrent launch requests
  if (launchLock) return launchLock;

  const envState = setupCamoufoxEnv();

  launchLock = (async () => {
    try {
      if (!isCamoufoxAvailable()) {
        throw new Error('camoufox-js package not found.');
      }

      const { Camoufox } = require('camoufox-js');
      
      if (envState) {
        if (envState.oldHome) process.env['HOME'] = envState.oldHome;
        if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
      }

      logger.log(`[Camoufox] Launching new stealth browser instance... (Pool Size: ${browserPool.length + 1})`);
      
      const browser = await Camoufox({
        headless: true,
        humanize: true,
        block_images: true
      });

      browserPool.push(browser);
      return browser;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      
      if ((msg.includes('binaries not found') || msg.includes('not installed')) && !camoufoxFetchAttempted) {
        camoufoxFetchAttempted = true;
        logger.warn('[Camoufox] Binaries missing, fetching...');
        const { execSync } = await import('child_process');
        execSync('npx camoufox-js fetch', { 
          stdio: 'inherit',
          env: { ...process.env, HOME: browserCacheDir, USERPROFILE: browserCacheDir }
        });
        const { Camoufox } = require('camoufox-js');
        const browser = await Camoufox({ headless: true, block_images: true });
        browserPool.push(browser);
        return browser;
      }

      logger.error('[Camoufox] Failed to launch browser:', error);
      throw error;
    } finally {
      launchLock = null;
    }
  })();

  return launchLock;
}

/**
 * Stop all browser instances in the pool
 */
export async function stopCamoufox(): Promise<void> {
  if (browserPool.length > 0) {
    logger.log(`[Camoufox] Stopping ${browserPool.length} stealth browser instances...`);
    await Promise.all(browserPool.map(b => b.close().catch(() => {})));
    browserPool.length = 0;
  }
}

// Register for automatic cleanup
shutdownManager.register(stopCamoufox);
