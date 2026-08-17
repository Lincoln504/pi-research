/**
 * The worker's task deadline has to reach the task it is bounding.
 *
 * `runTask` arms an AbortController from the scheduler's `taskTimeoutMs` and then
 * handed the signal to `executeScrapeTask` only. On a search or a health check it
 * fired into nothing: the controller aborted, and the sole use of it was a
 * post-hoc check AFTER the work had already returned, which relabels the result
 * but ends nothing.
 *
 * Playwright's per-verb timeouts still bound each individual action, but not their
 * sum, and not the jitter sleep after them — so the work could outlast the whole
 * task budget. That matters beyond the wasted time: poolifier counts a node as
 * executing until its worker replies, so an overrunning task keeps its worker
 * marked busy long after the caller was answered and gave up.
 *
 * Closing the page is what actually ends the work — any in-flight call rejects
 * with 'Target closed', which runTask's catch already maps back to the timeout.
 * That is the mechanism the scrape path has used all along; these tests pin that
 * search and the health probe now use it too.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  executeSearchTask,
  executeHealthCheck,
} from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

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

describe('worker task deadline reaches search and the health probe', () => {
  it('a search whose navigation hangs is ended by the task signal', async () => {
    const page = makeHangingPage();
    const controller = new AbortController();

    const running = executeSearchTask(makeContext(page), 'a query', controller.signal);
    // Nothing has ended on its own; the page is still open.
    await new Promise(r => setTimeout(r, 10));
    expect(page.closed).toBe(false);

    controller.abort();

    // The abort closes the page, which rejects the in-flight navigation. runTask's
    // catch reads signal.aborted and reports the task timeout.
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

    // It rejects rather than reporting an unhealthy verdict, which is right: an
    // aborted probe learned nothing about the browser, and runTask's catch turns it
    // into the task timeout. Reporting `success: false` would assert a fact the
    // probe never established.
    await expect(running).rejects.toThrow(/Target closed/);
    expect(page.close).toHaveBeenCalled();
  });

  it('an already-aborted signal ends the work immediately rather than starting it', async () => {
    // The task budget can expire while the page is being created — the binding has
    // to handle a signal that is already aborted when it is attached.
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

    // Close it so the hanging promise settles and the test does not leak.
    await page.close();
    await expect(running).rejects.toThrow();
  });
});
