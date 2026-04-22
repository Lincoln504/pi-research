/**
 * Camoufox Browser Lifecycle Manager
 *
 * Manages a singleton Camoufox (anti-detect Firefox) instance for stealth scraping.
 * Reuses the same browser process across sessions to minimize overhead.
 */

import { logger } from '../logger.ts';
import { shutdownManager } from '../utils/shutdown-manager.ts';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Robustly find the package root by looking for package.json.
 * This ensures the .browser directory is always in the npm install location,
 * regardless of the current working directory.
 */
function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    current = dirname(current);
  }
  // Fallback to relative path if package.json not found
  return resolve(startDir, '../../');
}

const packageRoot = findPackageRoot(__dirname);
const browserCacheDir = join(packageRoot, '.browser');

/**
 * Configure environment for local Camoufox storage.
 * Camoufox-js uses top-level constants in its 'pkgman' module that are 
 * calculated when the module is first loaded, based on os.homedir().
 * We override HOME/USERPROFILE in the process environment before requiring the package.
 */
function setupCamoufoxEnv() {
  if (!process.env['CAMOUFOX_LOCAL_CONFIGURED']) {
    // Cache the original HOME to be a good citizen
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

let sharedBrowser: any = null;
let launchPromise: Promise<any> | null = null;
let camoufoxFetchAttempted = false;

/**
 * Check if camoufox-js is installed
 */
function isCamoufoxAvailable(): boolean {
  try {
    const envState = setupCamoufoxEnv();
    require.resolve('camoufox-js');
    
    // Restore if we just configured it
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
 * Get or launch the shared Camoufox browser instance
 */
export async function getCamoufoxBrowser(): Promise<any> {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }

  if (launchPromise) {
    return launchPromise;
  }

  const envState = setupCamoufoxEnv();

  launchPromise = (async () => {
    try {
      if (!isCamoufoxAvailable()) {
        throw new Error('camoufox-js package not found. Please run: npm install camoufox-js');
      }

      // Dynamic import/require so the env override is in effect
      const { Camoufox } = require('camoufox-js');
      
      // RESTORE environment immediately after loading the module
      // pkgman.js has already calculated its constants.
      if (envState) {
        if (envState.oldHome) process.env['HOME'] = envState.oldHome;
        if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
      }

      logger.log('[Camoufox] Launching stealth browser...');
      
      sharedBrowser = await Camoufox({
        headless: true,
      });

      logger.log('[Camoufox] Stealth browser launched');
      return sharedBrowser;
    } catch (error) {
      // Restore on error as well
      if (envState) {
        if (envState.oldHome) process.env['HOME'] = envState.oldHome;
        if (envState.oldUserProfile) process.env['USERPROFILE'] = envState.oldUserProfile;
      }

      const msg = error instanceof Error ? error.message : String(error);
      
      // Handle missing binaries
      if ((msg.includes('Camoufox binaries not found') || msg.includes('not installed')) && !camoufoxFetchAttempted) {
        camoufoxFetchAttempted = true;
        logger.warn('[Camoufox] Binaries missing in local directory, attempting to fetch...');
        
        try {
          const { execSync } = await import('child_process');
          // Ensure fetch also uses the local HOME
          execSync('npx camoufox-js fetch', { 
            stdio: 'inherit',
            env: { ...process.env, HOME: browserCacheDir, USERPROFILE: browserCacheDir }
          });
          
          // Retry launch
          const { Camoufox } = require('camoufox-js');
          sharedBrowser = await Camoufox({ headless: true });
          return sharedBrowser;
        } catch (fetchErr) {
          logger.error('[Camoufox] Failed to fetch binaries:', fetchErr);
        }
      }

      logger.error('[Camoufox] Failed to launch browser:', error);
      throw error;
    } finally {
      launchPromise = null;
    }
  })();

  return launchPromise;
}

/**
 * Close the shared browser instance
 */
export async function stopCamoufox(): Promise<void> {
  if (sharedBrowser) {
    logger.log('[Camoufox] Stopping stealth browser...');
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

// Register for automatic cleanup
shutdownManager.register(stopCamoufox);
