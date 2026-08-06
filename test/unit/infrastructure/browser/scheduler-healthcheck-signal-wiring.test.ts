/**
 * Regression: BrowserTaskScheduler.startServer() wired onSearch/onScrape to
 * forward the per-request AbortSignal into runSearch/runScrape
 * (`(q, signal) => this.runSearch(q, undefined, signal)`), but onHealthCheck
 * was wired as `() => this.runHealthCheck()` — dropping any signal on the
 * floor even though runHealthCheck(config?, signal?) already implements the
 * identical slot-release-on-abort mechanism as runSearch/runScrape.
 *
 * This is the second half of the onHealthCheck signal-forwarding gap (see
 * browser-server.test.ts for the /healthcheck request-handler half): even once
 * BrowserServer passes requestAbort.signal into options.onHealthCheck(signal),
 * the scheduler's own startServer() wiring must actually forward it into
 * runHealthCheck rather than silently discarding it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BrowserTaskScheduler } from '../../../../src/infrastructure/browser/browser-task-scheduler.ts';

describe('BrowserTaskScheduler.startServer — onHealthCheck signal wiring', () => {
  let scheduler: BrowserTaskScheduler | null = null;

  afterEach(async () => {
    // Avoid full shutdown() (service registry / pool teardown) — this test
    // never touches those; just tear down the raw HTTP listener and idle timer.
    if (scheduler) {
      await (scheduler as any).server?.stop();
      clearTimeout((scheduler as any).idleTimer);
    }
    scheduler = null;
  });

  it('forwards the per-request AbortSignal into runHealthCheck, mirroring onSearch/onScrape', async () => {
    const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
    scheduler = new BrowserTaskScheduler('test-scheduler', stateManager, {} as any);
    const runHealthCheckSpy = vi.spyOn(scheduler, 'runHealthCheck').mockResolvedValue({ success: true });
    const runSearchSpy = vi.spyOn(scheduler, 'runSearch').mockResolvedValue([]);
    const runScrapeSpy = vi.spyOn(scheduler, 'runScrape').mockResolvedValue({} as any);

    await scheduler.startServer();

    const options = (scheduler as any).server.options as {
      onSearch: (q: string, signal?: AbortSignal) => Promise<unknown>;
      onScrape: (u: string, signal?: AbortSignal) => Promise<unknown>;
      onHealthCheck: (signal?: AbortSignal) => Promise<unknown>;
    };

    const controller = new AbortController();
    await options.onHealthCheck(controller.signal);
    expect(runHealthCheckSpy).toHaveBeenCalledWith(undefined, controller.signal);

    // onSearch/onScrape already forward correctly — assert the same shape so a
    // future refactor can't regress one route without this test catching it.
    await options.onSearch('q', controller.signal);
    expect(runSearchSpy).toHaveBeenCalledWith('q', undefined, controller.signal);
    await options.onScrape('u', controller.signal);
    expect(runScrapeSpy).toHaveBeenCalledWith('u', undefined, controller.signal);
  });

  it('still works when the caller passes no signal at all (the only production caller today)', async () => {
    const stateManager = { getBrowserServer: vi.fn(async () => null) } as any;
    scheduler = new BrowserTaskScheduler('test-scheduler-2', stateManager, {} as any);
    const runHealthCheckSpy = vi.spyOn(scheduler, 'runHealthCheck').mockResolvedValue({ success: true });

    await scheduler.startServer();
    const options = (scheduler as any).server.options as { onHealthCheck: (signal?: AbortSignal) => Promise<unknown> };
    await options.onHealthCheck(undefined);
    expect(runHealthCheckSpy).toHaveBeenCalledWith(undefined, undefined);
  });
});
