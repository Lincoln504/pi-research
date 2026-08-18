/**
 * The worker's task deadline has to reach the task it is bounding.
 *
 * `runTask` arms an AbortController from the scheduler's `taskTimeoutMs` and then
 * handed the signal to `executeScrapeTask` only. On a search or a health check it fired
 * into nothing: the controller aborted, and the sole use of it was a post-hoc check
 * AFTER the work had already returned, which relabels the result but ends nothing.
 *
 * Playwright's per-verb timeouts still bound each individual action, but not their sum,
 * and not the jitter sleep after them — so the work could outlast the whole task budget.
 * That matters beyond the wasted time: poolifier counts a node as executing until its
 * worker replies, so an overrunning task keeps its worker marked busy long after the
 * caller was answered and gave up.
 *
 * Closing the page is what actually ends the work — any in-flight call rejects with
 * 'Target closed', which runTask's catch already maps back to the timeout. That is the
 * mechanism the scrape path has used all along.
 *
 * Both halves are tested here, and the first version of this file tested only the
 * second. It drove `executeSearchTask` directly with a hand-made signal, proving the
 * LEAF honours a signal and never that `runTask` HANDS it one — so reverting
 * `runTask`'s two call sites to omit the signal, the exact regression the file exists
 * for, left every test green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the task function poolifier is handed, so runTask can be driven directly.
const captured = vi.hoisted(() => ({ runTask: null as null | ((d: any) => Promise<any>) }));
vi.mock('poolifier', () => ({
  ClusterWorker: class {
    constructor(fn: (d: any) => Promise<any>) { captured.runTask = fn; }
  },
}));

const browserMod = vi.hoisted(() => ({ context: null as any }));
vi.mock('../../../src/infrastructure/browser/thread-worker-browser.ts', () => ({
  setWorkerId: vi.fn(),
  initBrowser: vi.fn(async () => {}),
  acquireTaskContext: vi.fn(async () => browserMod.context),
  resetBrowser: vi.fn(),
  cleanupBrowser: vi.fn(async () => {}),
  taskStarted: vi.fn(),
  taskFinished: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/thread-worker-lifecycle.ts', () => ({
  setWorkerId: vi.fn(),
  setupIpcErrorHandler: vi.fn(),
  setupUncaughtExceptionHandler: vi.fn(),
  setupOrphanProtection: vi.fn(),
  createKillHandler: vi.fn(() => () => {}),
  setBrowserCleanup: vi.fn(),
}));

import {
  executeSearchTask,
  executeHealthCheck,
} from '../../../src/infrastructure/browser/thread-worker-messaging.ts';
import '../../../src/infrastructure/browser/thread-worker.ts';

/** A page that never settles its navigation unless it is closed. */
function makeHangingPage() {
  let rejectNav!: (e: Error) => void;
  const navBlocked = new Promise<never>((_, rej) => { rejectNav = rej; });
  const page = {
    closed: false,
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    goto: vi.fn(() => navBlocked),
    fill: vi.fn(async () => {}),
    keyboard: { press: vi.fn(async () => {}) },
    waitForNavigation: vi.fn(() => navBlocked),
    evaluate: vi.fn(async () => []),
    title: vi.fn(async () => 'ok'),
    content: vi.fn(async () => '<html></html>'),
    on: vi.fn(),
    route: vi.fn(async () => {}),
    close: vi.fn(async () => {
      page.closed = true;
      // Playwright's real behaviour: closing rejects whatever is in flight.
      rejectNav(new Error('Target closed'));
    }),
  };
  return page;
}

function makeContext(page: any) {
  return { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
}

describe('runTask hands its deadline to the work it is bounding', () => {
  beforeEach(() => { browserMod.context = null; });

  it('ends a hanging SEARCH at the task budget instead of letting it overrun', async () => {
    const page = makeHangingPage();
    browserMod.context = makeContext(page);

    const result = await captured.runTask!({ type: 'search', query: 'q', taskTimeoutMs: 60 });

    // The signal fired, closed the page, and runTask's catch mapped 'Target closed'
    // back to the task timeout. Without the signal being passed through, the hanging
    // navigation would never settle and this would not return at all.
    expect(result.error).toMatch(/Task timed out after 60ms/);
    expect(page.close).toHaveBeenCalled();
  }, 10_000);

  it('ends a hanging HEALTH CHECK the same way', async () => {
    const page = makeHangingPage();
    browserMod.context = makeContext(page);

    const result = await captured.runTask!({ type: 'healthcheck', taskTimeoutMs: 60 });

    expect(result.error).toMatch(/Task timed out after 60ms/);
    expect(page.close).toHaveBeenCalled();
  }, 10_000);

  it('leaves a task with no budget alone, so an unbounded caller is unaffected', async () => {
    const page = makeHangingPage();
    browserMod.context = makeContext(page);

    const running = captured.runTask!({ type: 'search', query: 'q', taskTimeoutMs: 0 });
    await new Promise(r => setTimeout(r, 30));
    expect(page.close).not.toHaveBeenCalled();

    await page.close(); // settle the hanging promise so the test does not leak
    await running;
  }, 10_000);
});

describe('the leaves honour the signal they are handed', () => {
  it('a search whose navigation hangs is ended by the task signal', async () => {
    const page = makeHangingPage();
    const controller = new AbortController();

    const running = executeSearchTask(makeContext(page), 'a query', controller.signal);
    await new Promise(r => setTimeout(r, 10));
    expect(page.closed).toBe(false);

    controller.abort();

    await expect(running).rejects.toThrow();
    expect(page.close).toHaveBeenCalled();
  });

  it('a health probe whose navigation hangs is ended the same way', async () => {
    const page = makeHangingPage();
    const controller = new AbortController();

    const running = executeHealthCheck(makeContext(page), 0, controller.signal);
    await new Promise(r => setTimeout(r, 10));
    expect(page.closed).toBe(false);

    controller.abort();

    // It rejects rather than reporting an unhealthy verdict, which is right: an aborted
    // probe learned nothing about the browser, and runTask's catch turns it into the
    // task timeout. Reporting `success: false` would assert a fact it never established.
    await expect(running).rejects.toThrow(/Target closed/);
    expect(page.close).toHaveBeenCalled();
  });

  it('an already-aborted signal ends the work immediately rather than starting it', async () => {
    // The task budget can expire while the page is being created — the binding has to
    // handle a signal that is already aborted when it is attached.
    const page = makeHangingPage();
    const controller = new AbortController();
    controller.abort();

    await expect(executeSearchTask(makeContext(page), 'q', controller.signal)).rejects.toThrow();
    expect(page.close).toHaveBeenCalled();
  });

  it('without a signal the work is left alone, so callers that pass none are unaffected', async () => {
    const page = makeHangingPage();
    const running = executeSearchTask(makeContext(page), 'q');

    await new Promise(r => setTimeout(r, 20));
    expect(page.close).not.toHaveBeenCalled();

    await page.close();
    await expect(running).rejects.toThrow();
  });
});
