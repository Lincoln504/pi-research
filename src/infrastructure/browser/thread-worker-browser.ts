/**
 * Thread Worker Browser Management
 *
 * Handles browser initialization, context management, and cleanup.
 */

import * as fs from 'node:fs';
import { setupMocking } from './thread-worker-messaging.ts';

let browser: any = null;
let context: any = null;
let initPromise: Promise<void> | null = null;
let workerId: string = '';

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/**
 * Check if browser is connected
 */
const isBrowserConnected = () => {
  try {
    return browser && typeof browser.isConnected === 'function' && browser.isConnected();
  } catch {
    return false;
  }
};

/**
 * Log to debug file
 */
function logToDebugFile(level: string, ...args: any[]): void {
  const logFile = process.env['PI_RESEARCH_LOG_FILE'];
  if (!logFile) return;

  try {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      workerId,
      message: args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' ')
    };
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // ignore
  }
}

/**
 * Initialize the browser instance
 */
export async function initBrowser(): Promise<void> {
  if (isBrowserConnected() && context) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (!isBrowserConnected() || !context) {
        logToDebugFile('INFO', `[Worker-${workerId}] Initializing browser instance...`);

        let CamoufoxModule: any;
        try {
          CamoufoxModule = await import('camoufox-js');
        } catch (e: any) {
          throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e.message}`, { cause: e });
        }

        const { Camoufox } = CamoufoxModule;

        // Launch browser without user_data_dir so Playwright creates an isolated
        // temp profile per instance. This avoids persistent-context semantics
        // (where context.browser() returns null) and the profile-lock contention
        // that came with sharing a single user_data_dir path.
        // Camoufox provides built-in fingerprint spoofing via humanize, os, locale,
        // screen, and geoip options. The addons[] option is for custom Firefox
        // extension directories only (not named strings like 'stealth').
        // Camoufox's built-in fingerprinting handles UA, timezone, geolocation, etc.
        // coherently. Manual overrides for those via launch options are silently
        // ignored by Playwright; set them at context level if needed, or rely on
        // camoufox defaults for a consistent, coordinated fingerprint.
        const launchTimeoutMs = 45000;
        const launchPromise = Camoufox({
          headless: true,
          humanize: true,
          locale: 'en-US',
          screen: {
            width: 1920,
            height: 1080,
            colorDepth: 24,
            pixelRatio: 1,
          },
        });

        const launchedBrowser = await Promise.race([
          launchPromise,
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error(`Browser launch timed out after ${launchTimeoutMs}ms`)), launchTimeoutMs)
          )
        ]);

        browser = launchedBrowser;
        context = await browser.newContext();
        
        // Setup mocking for CI if enabled
        await setupMocking(context);
        
        logToDebugFile('INFO', `[Worker-${workerId}] Browser initialized.`);
      }
    } catch (e: any) {
      // Close any partially-launched browser to avoid orphaning the process.
      if (browser && typeof browser.close === 'function') {
        browser.close().catch(() => {});
      }
      browser = null;
      context = null;
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.includes('Camoufox is not installed') || msg.includes('Version information not found')) {
        throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them.`, { cause: e });
      }

      throw e;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

/**
 * Get the current browser instance
 */
export function getBrowser(): any {
  return browser;
}

/**
 * Get the current browser context
 */
export function getContext(): any {
  return context;
}

/**
 * Reset browser and context (used after crashes)
 */
export function resetBrowser(): void {
  if (context) context.close().catch(() => {});
  if (browser) browser.close().catch(() => {});
  context = null;
  browser = null;
}

/**
 * Clean up browser resources with a timeout to prevent hanging
 */
export async function cleanupBrowser(): Promise<void> {
  const timeoutMs = 2000;
  
  const cleanup = async () => {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  };

  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Browser cleanup timed out')), timeoutMs))
    ]);
  } catch {
    // Ignore timeout error, we just want to ensure it doesn't hang
  } finally {
    context = null;
    browser = null;
  }
}
