/**
 * Thread Worker Browser Management
 *
 * Handles browser initialization, context management, and cleanup.
 *
 * NOTE: This file uses logToDebugFile() instead of the main-process logger because
 * worker threads run in separate isolated processes. All diagnostic output is
 * written to the file path in PI_RESEARCH_LOG_FILE (set by the worker pool manager).
 */

import { setupMocking } from './thread-worker-messaging.ts';
import { redactSecrets } from '../../utils/log-utils.ts';
import { resolveHeadlessMode } from './config.ts';

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
    logToDebugFile('DEBUG', '[ThreadWorker] browser.isConnected check threw, treating as disconnected');
    return false;
  }
};

/**
 * Log to the worker debug file (PI_RESEARCH_LOG_FILE).
 * This is the only logging mechanism available to worker processes —
 * the main-process logger is not accessible from isolated worker threads.
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
      message: redactSecrets(args.map(arg => {
        if (arg instanceof Error) return arg.stack || arg.message;
        if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg);
        return String(arg);
      }).join(' '))
    };
    // FIX (#32): Use async fs.appendFile to avoid blocking the event loop.
    import('node:fs/promises').then(fsp => fsp.appendFile(logFile, `${JSON.stringify(entry)}\n`)).catch(() => {});
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
        } catch (e: unknown) {
          throw new Error(`[Worker] camoufox-js not found in node_modules. Please run 'npm install'. Original error: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
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
        //
        // 90s launch timeout: CI runners (2 vCPU) need up to 60s to start Firefox
        // when it has both CPUs. The old 45s limit was too tight and caused silent
        // init failures under resource pressure.
        const launchTimeoutMs = 90000;
        const launchPromise = Camoufox({
          headless: resolveHeadlessMode(),
          humanize: true,
          locale: 'en-US',
          screen: {
            width: 1920,
            height: 1080,
            colorDepth: 24,
            pixelRatio: 1,
          },
        });

        // Guard with a hard timeout. We catch the launchPromise rejection so it
        // doesn't surface as an UnhandledPromiseRejection if it rejects after the
        // timeout races ahead.
        launchPromise.catch((err: Error) => logToDebugFile('DEBUG', `[ThreadWorker] Background browser launch rejection: ${err.message}`));
        let launchTimeoutId: NodeJS.Timeout | undefined;
        const launchedBrowser = await Promise.race([
          launchPromise,
          new Promise<never>((_, reject) => {
            launchTimeoutId = setTimeout(() => reject(new Error(`Browser launch timed out after ${launchTimeoutMs}ms`)), launchTimeoutMs);
          })
        ]);
        if (launchTimeoutId) clearTimeout(launchTimeoutId);

        browser = launchedBrowser;
        // newContext() can hang if the browser process becomes unresponsive immediately
        // after launch (e.g. OOM, GPU crash). Guard with a hard timeout.
        const contextPromise = browser.newContext();
        contextPromise.catch((err: Error) => logToDebugFile('DEBUG', `[ThreadWorker] Background browser context rejection: ${err.message}`));
        let contextTimeoutId: NodeJS.Timeout | undefined;
        context = await Promise.race([
          contextPromise,
          new Promise<never>((_, reject) => {
            contextTimeoutId = setTimeout(() => reject(new Error('Browser context creation timed out after 30000ms')), 30000);
          })
        ]);
        if (contextTimeoutId) clearTimeout(contextTimeoutId);
        
        // Setup mocking for CI if enabled
        await setupMocking(context);
        
        logToDebugFile('INFO', `[Worker-${workerId}] Browser initialized.`);
      }
    } catch (e: unknown) {
      // Close any partially-launched browser to avoid orphaning the process.
      // Promise.resolve() wraps the call safely: in headless:'virtual' mode,
      // camoufox-js browser.close() is synchronous (returns void), not a Promise.
      if (browser && typeof browser.close === 'function') {
        Promise.resolve(browser.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed browser close error during failed init: ${err.message}`));
      }
      browser = null;
      context = null;
      const msg = e instanceof Error ? e.message : String(e);

      if (msg.includes('Camoufox is not installed') || msg.includes('Version information not found')) {
        throw new Error(`[Worker] Browser binaries not found. Please run 'npm run setup' to install them.`, { cause: e });
      }

      // camoufox headless: "virtual" spawns Xvfb on Linux when no DISPLAY is set.
      // CannotFindXvfb is thrown when `which Xvfb` fails (xvfb not installed).
      const errName = e instanceof Error ? (e as any).constructor?.name ?? '' : '';
      if (errName === 'CannotFindXvfb' || errName === 'CannotExecuteXvfb' || msg.includes('Xvfb') || msg.includes('virtual display')) {
        throw new Error(
          '[Worker] No display server found on Linux. Install Xvfb for headless use (TTY/Wayland): sudo apt install xvfb',
          { cause: e }
        );
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
  if (context) Promise.resolve(context.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed context close error during reset: ${err.message}`));
  if (browser) Promise.resolve(browser.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed browser close error during reset: ${err.message}`));
  context = null;
  browser = null;
}

/**
 * Clean up browser resources with a timeout to prevent hanging
 */
export async function cleanupBrowser(): Promise<void> {
  const timeoutMs = 2000;
  
  const cleanup = async () => {
    if (context) await Promise.resolve(context.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed context close error during cleanup: ${err.message}`));
    if (browser) await Promise.resolve(browser.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed browser close error during cleanup: ${err.message}`));
  };

  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Browser cleanup timed out')), timeoutMs))
    ]);
  } catch {
    // Ignore timeout — we just want to ensure cleanup doesn't hang indefinitely
  } finally {
    context = null;
    browser = null;
  }
}
