/**
 * executeScrapeTask reports the document's FINAL URL (after server redirects and
 * client-side hops), so callers can say where content actually came from and
 * fetch_url can refuse a page that ended on http:. Harness mirrors
 * thread-worker-scrape-guards.test.ts: minimal page/context mocks, no browser.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';

const OK_HTML = `<html><body><p>${'lorem ipsum dolor sit amet '.repeat(300)}</p></body></html>`;

function makeHarness(opts: { pageUrl?: string; responseUrl?: string; contentType?: string } = {}) {
  const mainFrame = {};
  const response = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () => null,
    status: () => 200,
    url: () => opts.responseUrl ?? 'https://start.example/',
    headerValue: async (name: string) => (name.toLowerCase() === 'content-type' ? (opts.contentType ?? 'text/html') : null),
    body: async () => Buffer.from('%PDF-1.7 tiny'),
  };
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: () => {},
    goto: async () => response,
    content: async () => OK_HTML,
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    close: vi.fn(async () => {}),
    mainFrame: () => mainFrame,
    ...(opts.pageUrl ? { url: () => opts.pageUrl } : {}),
  };
  return { context: { newPage: async () => page } };
}

describe('executeScrapeTask — finalUrl', () => {
  beforeEach(() => { process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true'; });
  afterEach(() => { delete process.env['PI_RESEARCH_MOCK_SCRAPE']; });

  it('reports the main frame URL after client-side navigation (HTML)', async () => {
    const { context } = makeHarness({ responseUrl: 'https://start.example/', pageUrl: 'https://landed.example/after-js' });
    const result = await executeScrapeTask(context, 'https://start.example/');
    expect(result.finalUrl).toBe('https://landed.example/after-js');
  });

  it('falls back to the navigation response URL when page.url is unavailable', async () => {
    const { context } = makeHarness({ responseUrl: 'https://redirected.example/final' });
    const result = await executeScrapeTask(context, 'https://start.example/');
    expect(result.finalUrl).toBe('https://redirected.example/final');
  });

  it('reports the response URL for PDFs', async () => {
    const { context } = makeHarness({ responseUrl: 'https://files.example/doc.pdf', contentType: 'application/pdf' });
    const result = await executeScrapeTask(context, 'https://start.example/doc');
    expect(result.bufferB64).toBeDefined();
    expect(result.finalUrl).toBe('https://files.example/doc.pdf');
  });
});
