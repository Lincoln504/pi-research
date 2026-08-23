/**
 * Two ways the browser PDF fallback lost a document that had already been fetched,
 * both observed repeatedly in production run logs and both re-measured live:
 *
 *  1. "Response body ... was evicted!" — Firefox discards large navigation response
 *     bodies from its juggler-side cache. Measured against a 13.9MB TU Delft lecture
 *     PDF: response.body() fails whether it is called at headers-received time or
 *     after the load settles, so this is not a race that asking earlier can win. The
 *     bytes are re-requested through the browser context's own request API, which
 *     carries the same cookies, headers and TLS profile as the navigation.
 *
 *  2. "page.goto: Download is starting" — a server that sends the PDF with
 *     Content-Disposition: attachment makes Firefox route the response to the
 *     download manager, so no document is produced and goto() rejects. The PDF branch
 *     was never reached even though the bytes had arrived. The resulting Download is
 *     now read back from disk.
 *
 * Both fixes were verified against the exact URLs that failed: a Frontiers article PDF
 * (attachment-served) and the TU Delft PDF (evicted), which now return 106k and 27k
 * characters of extracted text respectively.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';
import { MAX_PDF_SIZE } from '../../../src/web-research/scraper-types.ts';

const PDF_BYTES = Buffer.from('%PDF-1.7\nreal document bytes\n%%EOF');
const EVICTED = 'response.body: Response body for GET https://evict.example.com/paper.pdf was evicted!';

/** Harness whose navigation response body is gone, with a working request API behind it. */
function makeEvictingHarness(opts: { apiStatus?: number; apiBody?: Buffer; apiThrows?: string } = {}) {
  const listeners: Record<string, any[]> = {};
  const mainFrame = {};
  const bodySpy = vi.fn(async () => { throw new Error(EVICTED); });
  const apiGet = vi.fn(async (_url: string, _opts?: Record<string, unknown>) => {
    if (opts.apiThrows) throw new Error(opts.apiThrows);
    const status = opts.apiStatus ?? 200;
    return {
      status: () => status,
      ok: () => status >= 200 && status < 300,
      headersArray: () => [{ name: 'Content-Length', value: String((opts.apiBody ?? PDF_BYTES).byteLength) }],
      body: async () => opts.apiBody ?? PDF_BYTES,
    };
  });
  const mainResponse = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () => ({ ipAddress: '93.184.216.34', port: 443 }),
    status: () => 200,
    url: () => 'https://evict.example.com/paper.pdf',
    headerValue: async (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null),
    body: bodySpy,
  };
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: (event: string, handler: any) => { (listeners[event] ??= []).push(handler); },
    goto: async () => {
      for (const h of listeners['response'] ?? []) h(mainResponse);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      return mainResponse;
    },
    content: async () => '<html></html>',
    waitForLoadState: async () => {},
    close: vi.fn(async () => {}),
    mainFrame: () => mainFrame,
    context: () => ({ request: { get: apiGet } }),
  };
  return { context: { newPage: async () => page }, page, bodySpy, apiGet };
}

/** Harness whose navigation turns into a download instead of a document. */
function makeDownloadHarness(opts: { filename?: string; bytes?: Buffer; failure?: string | null } = {}) {
  const listeners: Record<string, any[]> = {};
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-dl-test-'));
  const filePath = path.join(tmpDir, opts.filename ?? 'datasheet.pdf');
  fs.writeFileSync(filePath, opts.bytes ?? PDF_BYTES);

  const deleteSpy = vi.fn(async () => { fs.rmSync(filePath, { force: true }); });
  const download = {
    failure: async () => opts.failure ?? null,
    suggestedFilename: () => opts.filename ?? 'datasheet.pdf',
    url: () => 'https://attach.example.com/dl?id=9',
    path: async () => filePath,
    delete: deleteSpy,
  };

  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: (event: string, handler: any) => { (listeners[event] ??= []).push(handler); },
    goto: async () => {
      for (const h of listeners['download'] ?? []) h(download);
      throw new Error('page.goto: Download is starting');
    },
    waitForEvent: async () => download,
    content: async () => '<html></html>',
    waitForLoadState: async () => {},
    close: vi.fn(async () => {}),
    mainFrame: () => ({}),
  };
  return { context: { newPage: async () => page }, page, deleteSpy, filePath };
}

describe('executeScrapeTask — evicted PDF body', () => {
  beforeEach(() => { process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true'; });
  afterEach(() => { vi.clearAllMocks(); delete process.env['PI_RESEARCH_MOCK_SCRAPE']; });

  it('re-requests the document through the browser context instead of losing it', async () => {
    const { context, page, bodySpy, apiGet } = makeEvictingHarness();
    const result = await executeScrapeTask(context, 'https://evict.example.com/paper.pdf');

    expect(result.contentType).toContain('application/pdf');
    expect(Buffer.from(result.bufferB64!, 'base64').toString()).toBe(PDF_BYTES.toString());
    expect(bodySpy).toHaveBeenCalled();
    expect(apiGet).toHaveBeenCalledOnce();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('refuses to follow a redirect on the retry, so it cannot reach an unvalidated host', async () => {
    const { context, apiGet } = makeEvictingHarness();
    await executeScrapeTask(context, 'https://evict.example.com/paper.pdf');
    expect(apiGet.mock.calls[0]![1]).toMatchObject({ maxRedirects: 0 });
  });

  it('reports a retry that comes back 4xx as the HTTP outcome it is', async () => {
    const { context } = makeEvictingHarness({ apiStatus: 403 });
    await expect(
      executeScrapeTask(context, 'https://evict.example.com/paper.pdf'),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('still enforces the 100MB cap on the re-fetched body', async () => {
    const { context } = makeEvictingHarness({ apiBody: Buffer.alloc(MAX_PDF_SIZE + 1) });
    await expect(
      executeScrapeTask(context, 'https://evict.example.com/paper.pdf'),
    ).rejects.toThrow(/PDF too large \(\d+MB, max 100MB\)/);
  });

  it('releases the worker slot when the task deadline fires mid-retry', async () => {
    // Playwright's request API takes no AbortSignal and closing the page does not cancel
    // it, so a slow retry would otherwise pin the poolifier slot for the full re-fetch
    // timeout — long past the deadline that was supposed to free it.
    const { context } = makeEvictingHarness({ apiThrows: '' });
    const controller = new AbortController();
    const page: any = await (context as any).newPage();
    page.context = () => ({ request: { get: () => new Promise(() => {}) } });
    const started = executeScrapeTask({ newPage: async () => page }, 'https://evict.example.com/paper.pdf', controller.signal);
    // Give the navigation and the body failure time to land, then abort.
    await new Promise(r => setTimeout(r, 20));
    controller.abort();
    await expect(started).rejects.toThrow(/Aborted/);
  });

  it('leaves a non-eviction body failure with its original error', async () => {
    // A closed target is an infrastructure fault, not a discarded cache entry. Retrying
    // it would paper over a crashed browser and report success from a second request the
    // scrape never validated the way it validated the navigation.
    const { context, bodySpy, apiGet } = makeEvictingHarness();
    bodySpy.mockImplementation(async () => { throw new Error('Target closed'); });
    await expect(
      executeScrapeTask(context, 'https://evict.example.com/paper.pdf'),
    ).rejects.toThrow(/Target closed/);
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('executeScrapeTask — attachment-served PDF', () => {
  beforeEach(() => { process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true'; });
  afterEach(() => { vi.clearAllMocks(); delete process.env['PI_RESEARCH_MOCK_SCRAPE']; });

  it('recovers the document from the download instead of failing the URL', async () => {
    const { context, page, deleteSpy } = makeDownloadHarness();
    const result = await executeScrapeTask(context, 'https://attach.example.com/dl?id=9');
    expect(result.contentType).toBe('application/pdf');
    expect(Buffer.from(result.bufferB64!, 'base64').toString()).toBe(PDF_BYTES.toString());
    // The worker context is reused across tasks, so the temp file must not be left behind.
    expect(deleteSpy).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an attachment that is not a PDF as a routine unsupported target', async () => {
    const { context } = makeDownloadHarness({ filename: 'dataset.zip' });
    await expect(
      executeScrapeTask(context, 'https://attach.example.com/dl?id=9'),
    ).rejects.toThrow(/Unsupported download:/);
  });

  it('enforces the 100MB cap from the open handle, without reading the bytes', async () => {
    const { context } = makeDownloadHarness();
    const realOpen = fs.promises.open.bind(fs.promises);
    const readFileSpy = vi.fn();
    const closeSpy = vi.fn();
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
      const real: any = await realOpen(...(args as [any]));
      return {
        stat: async () => ({ size: MAX_PDF_SIZE + 1 }),
        readFile: (...a: any[]) => { readFileSpy(); return real.readFile(...a); },
        close: () => { closeSpy(); return real.close(); },
      } as any;
    });
    try {
      await expect(
        executeScrapeTask(context, 'https://attach.example.com/dl?id=9'),
      ).rejects.toThrow(/PDF too large \(\d+MB, max 100MB\)/);
      // Checked from the file size, so the oversized bytes are never read into the worker.
      expect(readFileSpy).not.toHaveBeenCalled();
      // ...and the descriptor is released even though the cap rejected the file.
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('reads the bytes back through the handle it measured, so the file cannot be swapped underneath', async () => {
    const { context, filePath } = makeDownloadHarness();
    // Replace the download with a different file at the same path in the window
    // between the size check and the read. Measuring one path and then reading it
    // again would hand back the impostor's bytes; measuring and reading one open
    // handle returns the file that was actually checked.
    const realOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: any[]) => {
      const real: any = await realOpen(...(args as [any]));
      const impostor = `${filePath}.impostor`;
      fs.writeFileSync(impostor, Buffer.from('%PDF-1.7\nSWAPPED\n%%EOF'));
      fs.renameSync(impostor, filePath);
      return real;
    });
    try {
      const result = await executeScrapeTask(context, 'https://attach.example.com/dl?id=9');
      expect(result.bufferB64).toBe(PDF_BYTES.toString('base64'));
    } finally {
      openSpy.mockRestore();
    }
  });

  it('surfaces a failed download rather than returning a truncated file', async () => {
    const { context } = makeDownloadHarness({ failure: 'canceled' });
    await expect(
      executeScrapeTask(context, 'https://attach.example.com/dl?id=9'),
    ).rejects.toThrow(/download failed \(canceled\)/);
  });

  it('leaves a non-download navigation failure untouched', async () => {
    const page: any = {
      setDefaultTimeout: () => {}, setDefaultNavigationTimeout: () => {},
      route: async () => {}, on: () => {},
      goto: async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); },
      close: vi.fn(async () => {}), mainFrame: () => ({}),
    };
    await expect(
      executeScrapeTask({ newPage: async () => page }, 'https://nope.example.com/x.pdf'),
    ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
  });
});
