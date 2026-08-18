/**
 * Unit Tests: resetBrowser() vs concurrently-dispatched sibling tasks, and
 * acquireTaskContext() vs concurrent tasks on the shared browser.
 *
 * Regression: poolifier's tasksQueueOptions.concurrency (WORKER_CONCURRENCY,
 * default 2 — worker-pool-manager.ts) dispatches more than one task at a time
 * to the SAME cluster worker process. resetBrowser() used to close/null the
 * shared browser AND its one shared BrowserContext unconditionally whenever a
 * task's error matched shouldResetBrowser() (e.g. a page-scoped Playwright
 * "Protocol error" from ONE crashed tab) — tearing them down out from under a
 * perfectly healthy sibling task still using that same context, which then
 * failed with a spurious, un-retried "browser closed" error.
 *
 * taskStarted()/taskFinished() let resetBrowser() defer the actual browser
 * teardown while sibling tasks are still active, applying it once the last
 * one finishes — unchanged by the context fix below, and still covered here.
 *
 * Separately: BrowserContext is no longer shared at all. acquireTaskContext()
 * now hands each task its OWN fresh context (cookies/storage/mocking do not
 * bleed between concurrent or sequential tasks on the same worker) — only the
 * underlying browser PROCESS stays shared, which is what these tests exercise
 * against the REAL exported functions (not a reimplementation) with a mocked
 * camoufox-js.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockCamoufox = vi.fn();
vi.mock('camoufox-js', () => ({
  Camoufox: mockCamoufox,
}));

vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>();
  return { ...real, platform: vi.fn().mockReturnValue('linux') };
});

import {
  initBrowser,
  acquireTaskContext,
  resetBrowser,
  taskStarted,
  taskFinished,
} from '../../../src/infrastructure/browser/thread-worker-browser.ts';

function fakeBrowser() {
  const contexts: any[] = [];
  const browser: any = {
    isConnected: () => true,
    newContext: vi.fn().mockImplementation(async () => {
      const ctx = { close: vi.fn().mockResolvedValue(undefined), route: vi.fn().mockResolvedValue(undefined) };
      contexts.push(ctx);
      return ctx;
    }),
    close: vi.fn().mockResolvedValue(undefined),
    _contexts: contexts,
  };
  return browser;
}

describe('resetBrowser() vs concurrent sibling tasks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Start from a clean, uninitialized module state for every test.
    resetBrowser();
  });

  it('defers the browser reset while a sibling task is still active, and applies it once the last one finishes', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();

    // Two sibling tasks dispatched concurrently to this worker, each with its
    // own context.
    taskStarted();
    const ctxA = await acquireTaskContext();
    taskStarted();
    const ctxB = await acquireTaskContext();
    expect(ctxA).not.toBe(ctxB);

    // Task A hits a page-scoped error and calls resetBrowser() — task B is
    // still active, so this must NOT close the shared browser yet.
    resetBrowser();
    expect(browser.close).not.toHaveBeenCalled();

    // Task A finishes — task B is still active, so the deferred reset still
    // must not have fired.
    taskFinished();
    expect(browser.close).not.toHaveBeenCalled();

    // Task B finishes — it was the last active task, so the deferred reset
    // now applies.
    taskFinished();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('resets immediately when no sibling task is active', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();

    taskStarted();
    resetBrowser();

    expect(browser.close).toHaveBeenCalledTimes(1);

    taskFinished();
  });

  it('a genuinely dead browser is still recovered on the next task via initBrowser()s own liveness check, even though reset was deferred', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();

    taskStarted();
    taskStarted();
    resetBrowser(); // deferred — sibling still active
    taskFinished(); // sibling still active (1 left)

    // The browser is now reported as disconnected (simulating a genuine
    // whole-browser crash) while the deferred reset hasn't applied yet.
    browser.isConnected = () => false;

    // A fresh initBrowser() call (the natural next-task entry point) must
    // still detect the dead browser and rebuild, regardless of the pending
    // deferred reset.
    const secondBrowser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(secondBrowser);
    await initBrowser();
    const ctx = await acquireTaskContext();
    expect(secondBrowser.newContext).toHaveBeenCalledTimes(1);
    expect(ctx).toBe(secondBrowser._contexts[0]);

    taskFinished();
  });
});

describe('acquireTaskContext() — per-task isolation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetBrowser();
  });

  it('hands each task a FRESH context, never a shared one — the cookie/storage-bleed fix', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();

    const ctx1 = await acquireTaskContext();
    const ctx2 = await acquireTaskContext();
    const ctx3 = await acquireTaskContext();

    expect(new Set([ctx1, ctx2, ctx3]).size).toBe(3);
    expect(browser.newContext).toHaveBeenCalledTimes(3);
  });
});
