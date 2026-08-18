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
let initPromise: Promise<void> | null = null;
let workerId: string = '';

// How many tasks this worker process currently has in flight. poolifier's
// tasksQueueOptions.concurrency (WORKER_CONCURRENCY, default 2 — see
// worker-pool-manager.ts) dispatches more than one task at a time to the SAME
// worker process, and every dispatched task shares this module's browser
// singleton (each gets its own FRESH BrowserContext via acquireTaskContext()
// below — a real Firefox process is too expensive to launch per task, but a
// context is cheap, and per-task contexts keep cookies/storage/route-mocking
// from one task bleeding into a concurrent or later, unrelated one).
// resetBrowser() uses this to avoid tearing the shared BROWSER down out from
// under a sibling task that is still actively using it — see resetBrowser()
// below.
let activeTaskCount = 0;
// A reset that resetBrowser() deferred because sibling tasks were still
// active, to be applied once the last one finishes.
let resetPending = false;
// The browser instance resetPending was requested against, captured at defer
// time. An intervening resetBrowser() call from a SIBLING task can take the
// immediate path (doResetBrowser() + a fresh initBrowser() relaunch) while
// this flag is still pending — see taskFinished() below for why the flag
// alone isn't enough to know whether it's still safe to apply.
let resetPendingForBrowser: any = null;

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
    const capturedBrowser = resetPendingForBrowser;
    resetPendingForBrowser = null;
    // A sibling task's OWN crash can call resetBrowser() while this flag is
    // still pending; if that call sees activeTaskCount <= 1 it takes the
    // IMMEDIATE path (doResetBrowser() below), which tears the browser down
    // and lets the next task's initBrowser() relaunch a brand-new, unrelated
    // instance — all without ever touching this flag. Applying a stale
    // deferred reset unconditionally would then tear down that later,
    // healthy instance instead of being the no-op it should be. Only apply
    // it if the browser is still the exact instance it was requested against.
    if (browser === capturedBrowser) {
      doResetBrowser();
    }
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
  if (isBrowserConnected()) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      if (!isBrowserConnected()) {
        logToDebugFile('INFO', `[Worker-${workerId}] Initializing browser instance...`);

        // ---------------------------------------------------------------------
        // Pinned browser stack — DO NOT caret-bump these three in isolation.
        // They are one coupled set (see package.json + docs/ARCHITECTURE.md).
        // Each was a real fresh-install/runtime break that our lockfile masked
        // (consumers install without our lockfile, so a floating range resolves
        // to a newer, broken version):
        //
        //   • camoufox-js  ^0.10.2  → the two ORIGINAL reasons for this pin have
        //     both lapsed (camoufox restored Windows assets in v152.0.4-beta.26,
        //     2026-07-16; and impit's `only-allow pnpm` guard existed only in
        //     0.13.1/0.14.0), but a THIRD, worse one replaced them. 0.12.0
        //     requires `better-sqlite3 ^13.0.1`, and better-sqlite3 13 DROPPED
        //     PREBUILT BINARIES: 12.x installs via `prebuild-install || node-gyp
        //     rebuild`, 13.x has no install script at all, so npm falls back to
        //     auto-running `node-gyp rebuild` for its binding.gyp and every
        //     install needs a full C++ toolchain. Measured: `npm ci` fails
        //     outright on the Windows CI runner ("could not find a version of
        //     Visual Studio 2017 or newer"), which is most Windows consumers.
        //     Upgrading again means checking better-sqlite3 first, not camoufox.
        //   • playwright-core  1.60.0 (exact) → playwright-core and the camoufox
        //     binary are one matched Juggler-protocol pair. 1.61 added a
        //     viewport.isMobile field the build REJECTS ("property
        //     viewport.isMobile not described in this scheme"), failing every
        //     launch below. Corroborated upstream: camoufox-js 0.12.0 declares
        //     `peerDependencies: playwright-core "<1.61.0"`, the same bound this
        //     pin has held by hand.
        //   • impit  0.13.0 (exact, a direct dep though only camoufox-js uses it)
        //     → camoufox-js 0.10.2 requires `impit ^0.13.0`, and within that range
        //     0.13.0 is the only version free of the `preinstall: npx only-allow
        //     pnpm` guard (an upstream mistake in 0.13.1/0.14.0, dropped again in
        //     0.14.1) that hard-fails `npm install -g`. The exact pin is also the
        //     ONLY way to force a version for consumers, since npm `overrides`
        //     don't propagate to installers of a published package.
        //
        // What is NOT pinned: the browser BINARY. `camoufox-js fetch` takes no
        // version argument — it walks the GitHub releases newest-first and takes
        // the first non-prerelease one with an asset for this OS/arch. A consumer
        // therefore gets whatever camoufox published most recently, whichever
        // camoufox-js they have, and a future release could break launches with no
        // change on our side. Both the current newest (v152.0.4-beta.28, Firefox
        // 152) and the older v135.0.1-beta.24 an existing cache may hold were
        // verified launching and driving under playwright-core 1.60.0.
        //
        // Always re-verify a REAL headless run after touching any of this: the
        // unit and integration suites mock the browser, so a Juggler mismatch
        // reaches production with a fully green suite.
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
            // Mute all audio output at the engine level. The general scrape
            // path drives a REAL Firefox (Camoufox), and a researcher can be
            // pointed at a youtube.com watch page through the ordinary
            // `scrape` tool (as opposed to the dedicated `youtube_transcript`
            // tool, which never touches the browser) — YouTube watch pages
            // autoplay video with sound, so without an explicit mute the
            // process plays audible audio through the host's sound device.
            //
            // media.volume_scale forces the browser's effective output
            // volume to 0 regardless of per-tab mute/autoplay state or any
            // page script re-enabling audio — the most reliable, engine-level
            // mute available for headless Firefox/Camoufox (the same pref
            // Selenium/Playwright Firefox test grids use to silence CI runs).
            // media.autoplay.default=5 additionally blocks autoplay outright
            // (belt-and-suspenders; some sites route around the volume scale
            // via Web Audio gain nodes). Neither pref affects rendering — the
            // page still loads and paints normally, only the audio output
            // device is silenced.
            //
            // Set on every platform/headless-mode combination, not just
            // Linux: this was only *observed* on Linux (true headless and
            // Xvfb-backed 'virtual' mode both retain a real PulseAudio/
            // PipeWire/ALSA sink for the Firefox process to play through),
            // but headless Firefox on macOS/Windows is not guaranteed to be
            // silent either, so the mute is applied unconditionally.
            firefox_user_prefs: {
              'media.volume_scale': '0.0',
              'media.autoplay.default': 5,
            },
          });
          // Guard with a hard timeout. We catch the launchPromise rejection so it
          // doesn't surface as an UnhandledPromiseRejection if it rejects after the
          // timeout races ahead.
          launchPromise.catch((err: Error) => logToDebugFile('DEBUG', `[ThreadWorker] Background browser launch rejection: ${err.message}`));
          let launchTimeoutId: NodeJS.Timeout | undefined;
          let raceLost = false;
          // If the launch resolves AFTER we gave up on it, nobody holds the result:
          // `browser` is assigned only from the race's winner, so the catch below —
          // whose comment promises to "close any partially-launched browser" — finds
          // null and closes nothing. Camoufox's own launch bound is 180s against our
          // 90s, so a launch completing in that window leaves a fully-started headless
          // Firefox with no owner, surviving the orphan sweep (its parent worker is
          // alive) until the pool shuts down. Adopt and close it, exactly as
          // createPageSafe already does for an orphaned page.
          launchPromise.then((b: any) => {
            if (!raceLost) return;
            logToDebugFile('WARN', `[Worker-${workerId}] Browser launch completed after its deadline; closing the orphaned instance.`);
            try { b?.close?.(); } catch { /* already gone */ }
          }).catch(() => { /* rejection already logged above */ });
          try {
            return await Promise.race([
              launchPromise,
              new Promise<never>((_, reject) => {
                launchTimeoutId = setTimeout(() => {
                  raceLost = true;
                  reject(new Error(`Browser launch timed out after ${launchTimeoutMs}ms`));
                }, launchTimeoutMs);
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
 * Create a FRESH BrowserContext for one task, against the shared browser
 * process. Call once per task, right after initBrowser() resolves; the
 * caller owns the returned context and must close it itself (in a `finally`,
 * covering the success, error, AND timeout-abort paths) once the task ends.
 *
 * Never reused across tasks — that was the bug this replaced. Two tasks
 * dispatched concurrently to the same worker (WORKER_CONCURRENCY > 1, the
 * default) used to share one BrowserContext, so cookies/storage a site set
 * for one task's request were visible to a different, unrelated task's later
 * request to the same site — a content-consistency gap with no counterpart
 * anywhere else in this codebase, which scopes browser-adjacent state
 * (circuit breakers, scrape caches) per session deliberately.
 *
 * The launch race/timeout/orphan-adoption pattern below is the exact one
 * initBrowser() used when context creation lived there (moved here wholesale,
 * not reinvented): newContext() can hang if the browser process is
 * unresponsive (OOM, GPU crash), so it is guarded with a hard timeout, and a
 * context that finishes creating AFTER that timeout is adopted and closed
 * rather than left to leak.
 */
export async function acquireTaskContext(): Promise<any> {
  const contextPromise = browser.newContext();
  contextPromise.catch((err: Error) => logToDebugFile('DEBUG', `[ThreadWorker] Background browser context rejection: ${err.message}`));
  let contextTimeoutId: NodeJS.Timeout | undefined;
  let contextRaceLost = false;
  contextPromise.then((c: any) => {
    if (!contextRaceLost) return;
    logToDebugFile('WARN', `[Worker-${workerId}] Browser context creation completed after its deadline; closing the orphaned context.`);
    try { c?.close?.(); } catch { /* already gone */ }
  }).catch(() => { /* rejection already logged above */ });
  let newContext: any;
  try {
    newContext = await Promise.race([
      contextPromise,
      new Promise<never>((_, reject) => {
        contextTimeoutId = setTimeout(() => {
          contextRaceLost = true;
          reject(new Error('Browser context creation timed out after 30000ms'));
        }, 30000);
      })
    ]);
  } finally {
    if (contextTimeoutId) clearTimeout(contextTimeoutId);
  }

  // Route interception is per-context, so mocking must be (re-)applied to
  // every fresh context, not just the first one ever created.
  await setupMocking(newContext);

  return newContext;
}

function doResetBrowser(): void {
  if (browser) Promise.resolve(browser.close()).catch((err: Error) => logToDebugFile('DEBUG', `[Worker-${workerId}] Swallowed browser close error during reset: ${err.message}`));
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
    resetPendingForBrowser = browser;
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
    // Closes every context still open under it (any task whose own close()
    // hasn't run yet) as a side effect — no separate context bookkeeping
    // needed here now that contexts are task-owned, not module-owned.
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
    browser = null;
  }
}
