/**
 * Redirect-aware PDF-vs-HTML classification on the fetch scrape path.
 *
 * scrapeWithFetch follows 3xx redirects manually and tracks the real
 * destination in `currentUrl`. The 1.4.2 fix made BOTH the size-cap check and
 * the extraction dispatch classify against `currentUrl`, not the stale original
 * parameter — a download endpoint without `.pdf` that redirects to the real
 * `.pdf` file (mislabeled content-type) must take the PDF branch, and a `.pdf`
 * URL that redirects to an HTML landing page must take the HTML branch. This
 * was shipped without a regression test; these pin it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: () => false, // no playwright/camoufox — keep this on the fetch path
}));

vi.mock('../../../src/web-research/scraper-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web-research/scraper-utils.ts')>()),
  // The scrape layer calls undici's fetch via getSsrfSafeFetcher; defer to the
  // per-test global stub so assertions are about classification, not transport.
  getSsrfSafeFetcher: async () => ({
    fetch: (url: string, init: Record<string, unknown>) =>
      (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
    dispatcher: {},
  }),
}));

const pdfMockState = vi.hoisted(() => ({ constructed: 0 }));
vi.mock('pdf-oxide-wasm', () => ({
  WasmPdfDocument: class {
    constructor(bytes: Uint8Array) {
      pdfMockState.constructed++;
      if (bytes.length === 0) throw new Error('empty or corrupt PDF buffer');
    }
    pageCount = () => 1;
    toMarkdown = () => 'PDF content';
    toMarkdownAll = () => 'Full PDF content ' + 'word '.repeat(100);
    free = () => {};
  },
}));

vi.mock('@kreuzberg/html-to-markdown-node', () => ({
  convert: vi.fn((html: string) => ({ content: html })),
  HeadingStyle: { Atx: {} },
  CodeBlockStyle: { Backticks: {} },
}));

const { scrapeSingle } = await import('../../../src/web-research/web-scraper.ts');

const HTML_BODY =
  '<h1>Landing page</h1><p>This is a long enough content to pass the fifty word check. ' +
  'Word word word word word word word word word word '.repeat(5) +
  '.</p>';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7 minimal body for the mock parser');

function redirectThen(finalResponse: () => any, location: string) {
  let calls = 0;
  return vi.fn(async (_url: string, _init: any) => {
    calls++;
    if (calls === 1) {
      return {
        status: 302,
        ok: false,
        headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
        body: { cancel: async () => {} },
      };
    }
    return finalResponse();
  });
}

describe('fetch scrape — redirect-aware PDF/HTML classification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    pdfMockState.constructed = 0;
  });

  it('classifies as PDF when a non-.pdf URL redirects to a .pdf file with a mislabeled content-type', async () => {
    vi.stubGlobal('fetch', redirectThen(() => ({
      status: 200,
      ok: true,
      // Mislabeled: the header alone would send this to the HTML branch.
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'application/octet-stream' : null) },
      arrayBuffer: async () => PDF_BYTES.buffer.slice(0),
      text: async () => 'binary junk if read as text',
    }), '/files/real-document.pdf'));

    const result = await scrapeSingle('https://docs.invalid/download?id=42');

    expect(result.success).toBe(true);
    expect(pdfMockState.constructed).toBeGreaterThan(0);   // PDF branch ran
    expect(result.markdown).toContain('Full PDF content');
  });

  it('classifies as HTML when a .pdf URL redirects to an HTML landing page', async () => {
    vi.stubGlobal('fetch', redirectThen(() => ({
      status: 200,
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      text: async () => HTML_BODY,
      arrayBuffer: async () => new TextEncoder().encode(HTML_BODY).buffer,
    }), '/viewer/landing'));

    const result = await scrapeSingle('https://docs.invalid/paper.pdf');

    expect(result.success).toBe(true);
    expect(pdfMockState.constructed).toBe(0);              // PDF branch never ran
    expect(result.markdown).toContain('Landing page');
  });
});
