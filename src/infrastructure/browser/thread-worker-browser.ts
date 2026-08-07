/**
 * Thread Worker Browser Management
 *
 * Handles browser initialization, context management, and cleanup.
 *
 * NOTE: This file uses logToDebugFile() instead of the main-process logger because
 * worker threads run in separate isolated processes. All diagnostic output is
 * written to the file path in PI_RESEARCH_LOG_FILE (set by the worker pool manager).
 */

import { platform } from 'node:os';
import { setupMocking } from './thread-worker-messaging.ts';
import { redactSecrets } from '../../utils/log-utils.ts';
import { resolveHeadlessMode } from './config.ts';

let browser: any = null;
let context: any = null;
let initPromise: Promise<void> | null = null;
let workerId: string = '';

// How many tasks this worker process currently has in flight. poolifier's
// tasksQueueOptions.concurrency (WORKER_CONCURRENCY, default 2 — see
// worker-pool-manager.ts) dispatches more than one task at a time to the SAME
// worker process, and every dispatched task shares this module's browser/
// context singletons (each gets its own page via createPageSafe(context), but
// the context/browser themselves are one shared instance). resetBrowser()
// uses this to avoid tearing that shared instance down out from under a
// sibling task that is still actively using it — see resetBrowser() below.
let activeTaskCount = 0;
// A reset that resetBrowser() deferred because sibling tasks were still
// active, to be applied once the last one finishes.
let resetPending = false;

/**
 * Set the worker ID for logging purposes
 */
export function setWorkerId(id: string): void {
  workerId = id;
}

/** Call when a task begins executing (before it touches the browser/context). */
export function taskStarted(): void {
  activeTaskCount++;
}

/** Call when a task finishes (success or failure), from a `finally` block. */
export function taskFinished(): void {
  activeTaskCount = Math.max(0, activeTaskCount - 1);
  if (activeTaskCount === 0 && resetPending) {
    resetPending = false;
    doResetBrowser();
  }
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
  // Match the main-process logger: WARN/ERROR are always recorded (crash diagnostics);
  // INFO/DEBUG only when verbose. Without this gate a non-verbose scaling run still
  // streamed thousands of worker DEBUG lines to PI_RESEARCH_LOG_FILE — often a tmpfs
  // (RAM) path — adding memory and I/O pressure for no benefit during sustained loops.
  if ((level === 'INFO' || level === 'DEBUG') && process.env['PI_RESEARCH_DEBUG'] !== 'true') return;

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

        // ---------------------------------------------------------------------
        // Pinned browser stack — DO NOT caret-bump these three in isolation.
        // They are one coupled set (see package.json + docs/ARCHITECTURE.md).
        // Each was a real fresh-install/runtime break that our lockfile masked
        // (consumers install without our lockfile, so a floating range resolves
        // to a newer, broken version):
        //
        //   • camoufox-js  ^0.10.2  → fetches camoufox Firefox 135 / beta.24, the
        //     NEWEST camoufox with binaries for every OS we support (Linux x64/
        //     arm64, macOS x64/arm64, Windows x64). FF146/FF150 dropped the
        //     Windows build entirely, so the 0.11.x line breaks Windows installs.
        //   • playwright-core  1.60.0 (exact) → playwright-core and the camoufox
        //     binary are one matched Juggler-protocol pair. 1.61 added a
        //     viewport.isMobile field the FF135 build REJECTS ("property
        //     viewport.isMobile not described in this scheme"), failing every
        //     launch below. 1.60.0 is the newest playwright the FF135 Juggler
        //     accepts.
        //   • impit  0.13.0 (exact, a direct dep though only camoufox-js uses it)
        //     → impit 0.13.1/0.14.0 shipped a `preinstall: npx only-allow pnpm`
        //     guard (an upstream mistake, fixed in 0.14.1+) that hard-fails
        //     `npm install -g`. Within camoufox-js's ^0.13.0 range 0.13.0 is the
        //     only guard-free version; a direct-dep pin is the ONLY way to force
        //     it for consumers (npm `overrides` don't propagate to installers of
        //     a published package).
        //
        // Removal: upgrade all three together when camoufox ships stable
        // cross-platform (incl. Windows) FF150 binaries — bumping camoufox-js to
        // ≥0.11.1 also drops the impit pin (0.11.1 requires the fixed impit
        // ^0.14.1) and needs playwright re-pinned to the new build's Juggler.
        // Always re-verify a real headless run on Linux/macOS/Windows after.
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
        const launchOnce = async (headless: boolean | 'virtual') => {
          const launchPromise = Camoufox({
            headless,
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
          try {
            return await Promise.race([
              launchPromise,
              new Promise<never>((_, reject) => {
                launchTimeoutId = setTimeout(() => reject(new Error(`Browser launch timed out after ${launchTimeoutMs}ms`)), launchTimeoutMs);
              })
            ]);
          } finally {
            if (launchTimeoutId) clearTimeout(launchTimeoutId);
          }
        };

        // Prefer true headless (no visible window — see resolveHeadlessMode).
        // Windows safety net: on a minority of Windows machines camoufox crashes
        // immediately in headless mode (exit 0x80000003 / STATUS_BREAKPOINT,
        // camoufox issue #614). If the headless launch fails for a non-timeout
        // reason there, fall back ONCE to a headed (visible) window so research
        // still works on those machines. Everywhere else the error propagates.
        const primaryHeadless = resolveHeadlessMode();
        let launchedBrowser: Awaited<ReturnType<typeof launchOnce>>;
        try {
          launchedBrowser = await launchOnce(primaryHeadless);
        } catch (launchErr: unknown) {
          const lmsg = launchErr instanceof Error ? launchErr.message : String(launchErr);
          const wasTimeout = lmsg.includes('timed out');
          if (platform() === 'win32' && primaryHeadless === true && !wasTimeout) {
            logToDebugFile('WARN', `[Worker-${workerId}] Headless browser launch failed on Windows (${lmsg}); falling back to a visible window so scraping still works (camoufox issue #614).`);
            launchedBrowser = await launchOnce(false);
          } else {
            throw launchErr;
          }
        }

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
        throw new Error(`[Worker] Browser binaries not found. Please run 'npx camoufox-js fetch' to install them.`, { cause: e });
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
 * Get the current browser context
 */
export function getContext(): any {
  return context;
}

function doResetBrowser(): void {
  if (context) Promise.resolve(context.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed context close error during reset: ${err.message}`));
  if (browser) Promise.resolve(browser.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed browser close error during reset: ${err.message}`));
  context = null;
  browser = null;
}

/**
 * Reset browser and context (used after crashes).
 *
 * A page/session-scoped failure in ONE task (e.g. Playwright/Juggler's
 * generic "Protocol error", thrown for a single crashed tab — not
 * necessarily the whole browser) must not tear down the browser/context a
 * CONCURRENTLY-RUNNING sibling task is still actively using (see
 * activeTaskCount's doc comment): that collaterally fails the sibling's
 * perfectly healthy work with a spurious "browser closed" error, un-retried.
 *
 * If other tasks are still in flight, defer instead of resetting immediately
 * — the deferred reset runs once the last active task finishes (taskFinished
 * above). A GENUINELY dead browser is still caught regardless: initBrowser()'s
 * own isBrowserConnected() check on the very next task re-initializes either
 * way, so deferring costs nothing in that case — it just avoids the
 * collateral damage in the much more common single-crashed-tab case.
 */
export function resetBrowser(): void {
  if (activeTaskCount > 1) {
    resetPending = true;
    return;
  }
  doResetBrowser();
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
