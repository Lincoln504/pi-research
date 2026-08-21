/**
 * Regression: the browser layer's PDF-vs-HTML DISPATCH must classify against the
 * response's own post-redirect URL, not the original task URL.
 *
 * The 1.5.0 redirect-aware fix wired resp.url() into the response-side
 * early-abort check but left the actual dispatch branch reading the task `url`
 * parameter, so both failure directions the fetch layer's currentUrl fix closed
 * remained open on the browser fallback path:
 *   (a) a download endpoint without `.pdf` that redirects to the real `.pdf`
 *       file served as application/octet-stream fell into the HTML branch, and
 *       page.content() serialized Firefox's PDF-viewer chrome as "content";
 *   (b) a `.pdf` task URL redirecting to an HTML page was fed to the PDF
 *       extractor, discarding perfectly good HTML.
 * These tests pin the dispatch itself: which branch's return shape comes back
 * ({bufferB64} = PDF branch, {html} = HTML branch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

// >5000 chars, no JS-shell markers, no Cloudflare patterns — needsWait stays off.
const OK_HTML = `<html><body><p>${'lorem ipsum dolor sit amet '.repeat(300)}</p></body></html>`;

interface HarnessOpts {
  contentType?: string;
  /** The response's own (post-redirect) URL — what resp.url() reports. */
  responseUrl?: string;
}

function makeHarness(opts: HarnessOpts = {}) {
  const mainFrame = {};
  const bodySpy = vi.fn(async () => Buffer.from('%PDF-1.7 tiny'));
  const response = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () => null,
    status: () => 200,
    url: () => opts.responseUrl ?? 'https://dispatch.example.com/page',
    headerValue: async (name: string) => {
      const headers: Record<string, string> = {
        'content-type': opts.contentType ?? 'text/html',
      };
      return headers[name.toLowerCase()] ?? null;
    },
    body: bodySpy,
  };
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: () => {},
    goto: async () => response,
    content: async () => OK_HTML,
    waitForLoadState: async () => {},
    waitForFunction: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    mainFrame: () => mainFrame,
  };
  const context = { newPage: async () => page };
  return { context, page, bodySpy };
}

describe('executeScrapeTask — PDF-vs-HTML dispatch is post-redirect-URL aware', () => {
  beforeEach(() => {
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
  });

  it('(a) non-.pdf task URL redirecting to a real .pdf (mislabeled octet-stream) takes the PDF branch', async () => {
    const { context, bodySpy } = makeHarness({
      contentType: 'application/octet-stream',
      responseUrl: 'https://cdn.example.com/files/real-document.pdf',
    });
    const result: any = await executeScrapeTask(context, 'https://dispatch.example.com/download?id=42');
    expect(result.bufferB64).toBeDefined();
    expect(result.html).toBeUndefined();
    expect(bodySpy).toHaveBeenCalled();
  });

  it('(b) .pdf task URL redirecting to an HTML page takes the HTML branch', async () => {
    const { context, bodySpy } = makeHarness({
      contentType: 'text/html',
      responseUrl: 'https://dispatch.example.com/article/landing',
    });
    const result: any = await executeScrapeTask(context, 'https://dispatch.example.com/download/report.pdf');
    expect(result.html).toContain('lorem ipsum');
    expect(result.bufferB64).toBeUndefined();
    // The whole point of direction (b): the HTML body must never be fed to the
    // PDF extractor's buffer path.
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it('a direct .pdf URL with no redirect still takes the PDF branch (response.url() === task url)', async () => {
    const { context } = makeHarness({
      contentType: 'application/octet-stream',
      responseUrl: 'https://dispatch.example.com/direct.pdf',
    });
    const result: any = await executeScrapeTask(context, 'https://dispatch.example.com/direct.pdf');
    expect(result.bufferB64).toBeDefined();
  });

  it('a mock response without url() falls back to the task URL (harness compatibility)', async () => {
    const { context } = makeHarness({ contentType: 'application/octet-stream' });
    // Strip url() to simulate the minimal-response shape older harnesses use.
    const page = await (context as any).newPage();
    const resp = await page.goto();
    delete (resp as any).url;
    const result: any = await executeScrapeTask(context, 'https://dispatch.example.com/fallback.pdf');
    expect(result.bufferB64).toBeDefined();
  });
});
