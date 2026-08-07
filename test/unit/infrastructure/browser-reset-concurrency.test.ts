/**
 * Unit Tests: resetBrowser() vs concurrently-dispatched sibling tasks
 *
 * Regression: poolifier's tasksQueueOptions.concurrency (WORKER_CONCURRENCY,
 * default 2 — worker-pool-manager.ts) dispatches more than one task at a time
 * to the SAME cluster worker process. Every dispatched task shares this
 * module's browser/context singletons. resetBrowser() used to close/null them
 * unconditionally whenever a task's error matched shouldResetBrowser() (e.g. a
 * page-scoped Playwright "Protocol error" from ONE crashed tab) — tearing the
 * shared browser/context down out from under a perfectly healthy sibling task
 * still using it, which then failed with a spurious, un-retried "browser
 * closed" error.
 *
 * taskStarted()/taskFinished() now let resetBrowser() defer the actual
 * teardown while sibling tasks are still active, applying it once the last
 * one finishes. These tests drive the REAL exported functions (not a
 * reimplementation) against a mocked camoufox-js.
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
  getContext,
  resetBrowser,
  taskStarted,
  taskFinished,
} from '../../../src/infrastructure/browser/thread-worker-browser.ts';

function fakeBrowser() {
  const fakeContext = {
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
  };
  return {
    isConnected: () => true,
    newContext: vi.fn().mockResolvedValue(fakeContext),
    close: vi.fn().mockResolvedValue(undefined),
    _fakeContext: fakeContext,
  };
}

describe('resetBrowser() vs concurrent sibling tasks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Start from a clean, uninitialized module state for every test.
    resetBrowser();
  });

  it('defers the reset while a sibling task is still active, and applies it once the last one finishes', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();
    const context = getContext();
    expect(context).toBe(browser._fakeContext);

    // Two sibling tasks dispatched concurrently to this worker.
    taskStarted();
    taskStarted();

    // Task A hits a page-scoped error and calls resetBrowser() — task B is
    // still active, so this must NOT close the shared browser/context yet.
    resetBrowser();
    expect(browser._fakeContext.close).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    expect(getContext()).toBe(context);

    // Task A finishes — task B is still active, so the deferred reset still
    // must not have fired.
    taskFinished();
    expect(browser._fakeContext.close).not.toHaveBeenCalled();
    expect(getContext()).toBe(context);

    // Task B finishes — it was the last active task, so the deferred reset
    // now applies.
    taskFinished();
    expect(browser._fakeContext.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(getContext()).toBeNull();
  });

  it('resets immediately when no sibling task is active', async () => {
    const browser = fakeBrowser();
    mockCamoufox.mockResolvedValueOnce(browser);
    await initBrowser();

    taskStarted();
    resetBrowser();

    expect(browser._fakeContext.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(getContext()).toBeNull();

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
    expect(getContext()).toBe(secondBrowser._fakeContext);

    taskFinished();
  });
});
