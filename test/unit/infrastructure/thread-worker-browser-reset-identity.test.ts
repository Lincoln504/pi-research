/**
 * Regression: resetBrowser()'s deferred reset (activeTaskCount > 1 case) was
 * a bare boolean with no identity tied to which browser instance it was
 * requested against.
 *
 * Trace that broke it:
 *   1. Task A crashes while task B is still active (count=2) -> resetPending
 *      deferred (browser1 still running).
 *   2. Task A finishes (count=1).
 *   3. Task B ALSO crashes independently, calling resetBrowser() itself.
 *      With only B left active (count=1), that call takes the IMMEDIATE path
 *      -> browser1 is torn down and nulled right away. resetPending (from
 *      step 1) is untouched, still true.
 *   4. Task C starts (count=2), calls initBrowser() -> browser1 is gone, so
 *      a brand-new, healthy browser2 is launched. C finishes successfully
 *      (count=1).
 *   5. Task B's own finally block runs taskFinished() (count=0). resetPending
 *      is still true from step 1 -> the deferred reset fires and, pre-fix,
 *      unconditionally tore down whatever browser/context is CURRENT — i.e.
 *      browser2, a healthy instance task C just used and a later task D
 *      would have reused. The fix binds the deferred flag to the specific
 *      browser instance captured at defer time, so it only applies if that
 *      instance is still current.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { createdInstances } = vi.hoisted(() => ({ createdInstances: [] as any[] }));

vi.mock('camoufox-js', () => ({
  Camoufox: vi.fn(async () => {
    const n = createdInstances.length + 1;
    const context = {
      id: `context-${n}`,
      close: vi.fn(async () => {}),
      route: vi.fn(async () => {}),
    };
    const browser: any = {
      id: `browser-${n}`,
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    browser.__context = context;
    createdInstances.push(browser);
    return browser;
  }),
}));

describe('thread-worker-browser — deferred resetBrowser() instance identity', () => {
  beforeEach(() => {
    createdInstances.length = 0;
    vi.resetModules();
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  it('does not tear down a later, healthy browser relaunched after a stale deferred reset', async () => {
    const mod = await import('../../../src/infrastructure/browser/thread-worker-browser.ts');
    const { taskStarted, taskFinished, initBrowser, resetBrowser, getContext } = mod;

    // Task A and Task B both active.
    taskStarted(); // A: count=1
    taskStarted(); // B: count=2

    await initBrowser(); // launches browser1
    expect(createdInstances.length).toBe(1);
    const browser1 = createdInstances[0];

    // Task A crashes: deferred (count=2 > 1).
    resetBrowser();
    // Task A finishes.
    taskFinished(); // count=1

    // Task B independently crashes too. Only B left active (count=1), so
    // this takes the IMMEDIATE reset path, tearing down browser1 right now.
    resetBrowser();
    expect(browser1.close).toHaveBeenCalledTimes(1);
    expect(browser1.__context.close).toHaveBeenCalledTimes(1);
    expect(getContext()).toBeNull();

    // Task C starts, relaunches a fresh, healthy browser2.
    taskStarted(); // count=2
    await initBrowser();
    expect(createdInstances.length).toBe(2);
    const browser2 = createdInstances[1];
    expect(getContext()).toBe(browser2.__context);

    // Task C finishes successfully.
    taskFinished(); // count=1

    // Task B's own finally block now runs, applying the STALE deferred
    // reset from step 1 (targeting browser1, long gone).
    taskFinished(); // count=0 -> flushes resetPending

    // browser2 must be untouched — the deferred reset was stale and should
    // have been a no-op.
    expect(browser2.close).not.toHaveBeenCalled();
    expect(browser2.__context.close).not.toHaveBeenCalled();
    expect(getContext()).toBe(browser2.__context);
  });

  it('still applies a deferred reset when the browser instance is unchanged', async () => {
    const mod = await import('../../../src/infrastructure/browser/thread-worker-browser.ts');
    const { taskStarted, taskFinished, initBrowser, resetBrowser, getContext } = mod;

    taskStarted(); // A: count=1
    taskStarted(); // B: count=2

    await initBrowser();
    const browser1 = createdInstances[0];

    resetBrowser(); // deferred (count=2 > 1), targets browser1
    taskFinished(); // A finishes, count=1
    taskFinished(); // B finishes normally, count=0 -> flush

    expect(browser1.close).toHaveBeenCalledTimes(1);
    expect(getContext()).toBeNull();
  });
});
