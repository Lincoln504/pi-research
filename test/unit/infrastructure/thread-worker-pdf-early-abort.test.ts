/**
 * Regression: a declared-oversized PDF used to be caught only AFTER page.goto()
 * finished downloading the whole body — for a direct navigation to a PDF URL,
 * Playwright's goto() does not resolve until the download completes, so the full
 * (possibly multi-hundred-MB) response was pulled into the browser process before
 * the worker-side size check (thread-worker-scrape-guards.test.ts) ever ran.
 *
 * page.on('response') fires on headers-received, well before the body finishes
 * transferring. executeScrapeTask now inspects the main-frame document response's
 * Content-Type/Content-Length there and, if it already declares an oversized PDF,
 * closes the page immediately — aborting the in-flight download instead of
 * finishing it first. This only closes the gap for a server that HONESTLY
 * declares an oversized length up front; a chunked/lying response still falls
 * through to the existing post-download byte check (unaffected by this file).
 *
 * The harness's goto() simulates an ONGOING download as a series of ticks (the
 * real analogue of bytes still streaming in) rather than resolving instantly, so
 * a test can tell "aborted after the first tick" (the fix) apart from "ran the
 * full simulated download, THEN got caught by the existing post-goto check" (the
 * old behavior) — both throw the identical 'PDF too large' message and never call
 * response.body(), which is why an outcome-only assertion (message + body-not-
 * called) cannot tell them apart; only how many ticks elapsed can.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';
import { MAX_PDF_SIZE } from '../../../src/web-research/scraper-types.ts';

const DOWNLOAD_TICKS = 10;

function makeHarness(opts: { contentType?: string; contentLength?: number } = {}) {
  const listeners: Record<string, any[]> = {};
  let closed = false;
  let ticksElapsed = 0;
  const mainFrame = {};
  const bodySpy = vi.fn(async () => Buffer.from('should never be read'));
  const mainResponse = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () => ({ ipAddress: '93.184.216.34', port: 443 }),
    status: () => 200,
    headerValue: async (name: string) => {
      const headers: Record<string, string> = {
        'content-type': opts.contentType ?? 'application/pdf',
        ...(opts.contentLength !== undefined ? { 'content-length': String(opts.contentLength) } : {}),
      };
      return headers[name.toLowerCase()] ?? null;
    },
    body: bodySpy,
  };
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: (event: string, handler: any) => { (listeners[event] ??= []).push(handler); },
    goto: async () => {
      for (const h of listeners['response'] ?? []) h(mainResponse);
      // Simulate an ongoing download: real Playwright would not resolve goto()
      // until every byte arrived. A page.close() fired by the response-side
      // early-abort check should cut this off within the first tick or two,
      // long before DOWNLOAD_TICKS elapses.
      for (let i = 0; i < DOWNLOAD_TICKS; i++) {
        if (closed) throw new Error('Target closed');
        await Promise.resolve().then(() => {}).then(() => {}); // let pending microtask chains (the header-check) settle
        ticksElapsed = i + 1;
      }
      if (closed) throw new Error('Target closed');
      return mainResponse;
    },
    content: async () => '<html></html>',
    waitForLoadState: async () => {},
    close: vi.fn(async () => { closed = true; }),
    mainFrame: () => mainFrame,
  };
  const context = { newPage: async () => page };
  return { context, page, bodySpy, ticksElapsed: () => ticksElapsed };
}

describe('executeScrapeTask — PDF early-abort on declared oversized Content-Length', () => {
  beforeEach(() => {
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
  });

  it('aborts the in-flight download within the first tick, instead of letting it run to completion first', async () => {
    const { context, page, bodySpy, ticksElapsed } = makeHarness({ contentLength: MAX_PDF_SIZE + 1 });
    await expect(
      executeScrapeTask(context, 'https://early-abort-a.example.com/huge.pdf'),
    ).rejects.toThrow(/PDF too large \(\d+MB, max 100MB\)/);
    expect(page.close).toHaveBeenCalled();
    expect(bodySpy).not.toHaveBeenCalled();
    // The load-bearing assertion: the simulated download was cut short almost
    // immediately, not allowed to run for all DOWNLOAD_TICKS iterations first.
    // Pre-fix, nothing closes the page during goto() — the existing post-goto
    // declaredLength check only runs AFTER goto() resolves, so this would be
    // DOWNLOAD_TICKS, not a small number.
    expect(ticksElapsed()).toBeLessThan(DOWNLOAD_TICKS);
  });

  it('does not abort a PDF whose declared length is within the cap', async () => {
    const { context, page, ticksElapsed } = makeHarness({ contentLength: 1024 });
    const result = await executeScrapeTask(context, 'https://early-abort-b.example.com/small.pdf');
    expect(result.bufferB64).toBeDefined();
    expect(ticksElapsed()).toBe(DOWNLOAD_TICKS); // ran the full simulated download, as a legitimate PDF should
    expect(page.close).toHaveBeenCalledTimes(1); // only the normal success-path close
  });

  it('does not touch a non-PDF response even with a huge declared length', async () => {
    const { context, page, ticksElapsed } = makeHarness({ contentType: 'text/html', contentLength: MAX_PDF_SIZE + 1 });
    const result = await executeScrapeTask(context, 'https://early-abort-c.example.com/');
    expect(result.html).toBeDefined();
    expect(ticksElapsed()).toBe(DOWNLOAD_TICKS);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('does not abort when Content-Length is absent (chunked) — falls through to the existing post-download check', async () => {
    const { context, page, ticksElapsed } = makeHarness({ contentLength: undefined });
    const result = await executeScrapeTask(context, 'https://early-abort-d.example.com/ok.pdf');
    expect(result.bufferB64).toBeDefined();
    expect(ticksElapsed()).toBe(DOWNLOAD_TICKS);
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});
