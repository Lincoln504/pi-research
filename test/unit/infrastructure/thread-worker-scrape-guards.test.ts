/**
 * Regression tests for executeScrapeTask's HTTP-status and size-cap guards.
 *
 * Status (W: browser scrape ignored HTTP status): page.goto's response.status()
 * was never consulted, so 404/500/403 pages returned as normal
 * {contentType, html} results — major sites' rich error pages cleared the stub
 * gate, were cached as scrape SUCCESS, and became citable. The fetch layer
 * enforces !response.ok; the browser layer must match it with `HTTP <status>`.
 * The one legitimate exception: Cloudflare challenges arrive with 403/503 and
 * the challenge wait can clear them to the real page — a resolved challenge
 * must still return content, an unresolved one keeps its 'Fetch blocked:'
 * classification.
 *
 * Size caps (W: worker-side reads were uncapped): the 100MB PDF / 25MB HTML
 * caps ran only in the PARENT, after the bytes had already been buffered in the
 * worker (plus a base64 copy for PDFs) and shipped over JSON IPC. A
 * multi-hundred-MB PDF could OOM-kill the worker — stranding sibling tasks —
 * or hit ERR_STRING_TOO_LONG. The worker must enforce the same limits with the
 * parent's error wording.
 *
 * Harness mirrors thread-worker-ssrf-subresource.test.ts: minimal page/context
 * mocks, no real browser. serverAddr() returns null (cached/fulfilled shape),
 * so no SSRF machinery is exercised here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';
import { isBenignScrapeFailure } from '../../../src/web-research/scraper-utils.ts';
import { MAX_HTML_SIZE, MAX_PDF_SIZE } from '../../../src/web-research/scraper-types.ts';

// >5000 chars, none of the JS-shell markers, no Cloudflare patterns — the
// needsWait branch stays off and the page reads as a normal article.
const OK_HTML = `<html><body><p>${'lorem ipsum dolor sit amet '.repeat(300)}</p></body></html>`;
// Contains a Cloudflare interstitial marker so the challenge branch engages.
const CF_HTML = `<html><body><title>Just a moment...</title>${'checking '.repeat(30)}</body></html>`;

interface HarnessOpts {
  status?: number;
  contentType?: string;
  headers?: Record<string, string>;
  /** Implementation for response.body() (PDF branch). */
  body?: () => Promise<any>;
  /** Sequence of page.content() return values (last one repeats). */
  contents?: string[];
  /** page.waitForFunction impl — resolve = challenge cleared, reject = still blocked. */
  waitForFunction?: () => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const mainFrame = {};
  const bodySpy = vi.fn(opts.body ?? (async () => Buffer.from('%PDF-1.7 tiny')));
  const response = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () => null,
    status: () => opts.status ?? 200,
    headerValue: async (name: string) => {
      const headers: Record<string, string> = {
        'content-type': opts.contentType ?? 'text/html',
        ...(opts.headers ?? {}),
      };
      return headers[name.toLowerCase()] ?? null;
    },
    body: bodySpy,
  };
  let contentCalls = 0;
  const contents = opts.contents ?? [OK_HTML];
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async () => {},
    on: () => {},
    goto: async () => response,
    content: async () => contents[Math.min(contentCalls++, contents.length - 1)],
    waitForLoadState: async () => {},
    waitForFunction: vi.fn(opts.waitForFunction ?? (async () => {})),
    close: vi.fn(async () => {}),
    mainFrame: () => mainFrame,
  };
  const context = { newPage: async () => page };
  return { context, page, bodySpy };
}

describe('executeScrapeTask — HTTP status enforcement', () => {
  beforeEach(() => {
    // Zero out the human-behavior jitter so tests are fast (env is read per task).
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
  });

  it('rejects an HTML 404 with `HTTP 404` instead of returning the error page as content', async () => {
    const { context } = makeHarness({ status: 404 });
    const err: unknown = await executeScrapeTask(context, 'https://status-a.example.com/missing').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('HTTP 404');
    // Same benign per-URL classification as the fetch layer's HTTP errors.
    expect(isBenignScrapeFailure(err)).toBe(true);
  });

  it('rejects an HTML 500 with `HTTP 500`', async () => {
    const { context } = makeHarness({ status: 500 });
    await expect(
      executeScrapeTask(context, 'https://status-b.example.com/broken'),
    ).rejects.toThrow('HTTP 500');
  });

  it('throws `HTTP <status>` for an errored PDF response BEFORE buffering the body', async () => {
    const { context, bodySpy } = makeHarness({ status: 500, contentType: 'application/pdf' });
    await expect(
      executeScrapeTask(context, 'https://status-c.example.com/file.pdf'),
    ).rejects.toThrow('HTTP 500');
    // The whole point: the error page's bytes were never buffered.
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it('still returns real content when a Cloudflare-challenged 403 resolves', async () => {
    const { context } = makeHarness({
      status: 403,
      contents: [CF_HTML, OK_HTML],
      waitForFunction: async () => {}, // challenge clears
    });
    const result = await executeScrapeTask(context, 'https://status-d.example.com/protected');
    expect(result.html).toContain('lorem ipsum');
  });

  it('keeps an unresolved Cloudflare challenge as `Fetch blocked:`, not `HTTP <status>`', async () => {
    const { context } = makeHarness({
      status: 403,
      contents: [CF_HTML],
      waitForFunction: async () => { throw new Error('Timeout 5000ms exceeded'); },
    });
    await expect(
      executeScrapeTask(context, 'https://status-e.example.com/blocked'),
    ).rejects.toThrow('Fetch blocked: Cloudflare challenge');
  });

  it('returns content normally for a 200', async () => {
    const { context } = makeHarness({ status: 200 });
    const result = await executeScrapeTask(context, 'https://status-f.example.com/ok');
    expect(result.html).toContain('lorem ipsum');
    expect(result.contentType).toContain('text/html');
  });
});

describe('executeScrapeTask — worker-side size caps', () => {
  beforeEach(() => {
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
  });

  it('rejects a PDF whose Content-Length exceeds the cap WITHOUT buffering the body', async () => {
    const { context, bodySpy } = makeHarness({
      contentType: 'application/pdf',
      headers: { 'content-length': String(MAX_PDF_SIZE + 1) },
    });
    await expect(
      executeScrapeTask(context, 'https://size-a.example.com/huge.pdf'),
    ).rejects.toThrow(/PDF too large \(\d+MB, max 100MB\)/);
    expect(bodySpy).not.toHaveBeenCalled();
  });

  it('rejects an over-cap PDF body after the read, BEFORE the base64 copy doubles it', async () => {
    // The header is advisory (absent here, as on chunked responses); the byte
    // check must catch it. toString('base64') on a >100MB buffer is the
    // allocation the cap exists to prevent — it must never run.
    const toBase64 = vi.fn(() => 'x');
    const { context } = makeHarness({
      contentType: 'application/pdf',
      body: async () => ({ byteLength: MAX_PDF_SIZE + 1, toString: toBase64 }),
    });
    await expect(
      executeScrapeTask(context, 'https://size-b.example.com/chunked.pdf'),
    ).rejects.toThrow(/PDF too large \(\d+MB, max 100MB\)/);
    expect(toBase64).not.toHaveBeenCalled();
  });

  it('rejects rendered HTML over the 25MB cap with the parent error wording', async () => {
    const { context } = makeHarness({ contents: ['x'.repeat(MAX_HTML_SIZE + 1)] });
    // Settle to an error value rather than rejects.toThrow: a pre-fix resolution
    // would otherwise make vitest print the 25MB html string in the diff.
    const err: unknown = await executeScrapeTask(context, 'https://size-c.example.com/balloon').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Browser HTML too large \(\d+MB, max 25MB\)/);
  });

  it('still returns a normal-size PDF as base64', async () => {
    const bytes = Buffer.from('%PDF-1.7 small payload');
    const { context } = makeHarness({
      contentType: 'application/pdf',
      headers: { 'content-length': String(bytes.byteLength) },
      body: async () => bytes,
    });
    const result = await executeScrapeTask(context, 'https://size-d.example.com/ok.pdf');
    expect(result.bufferB64).toBe(bytes.toString('base64'));
  });

  it('takes the PDF branch off the URL extension even when the server mislabels content-type', async () => {
    // Regression: a server that omits or mislabels content-type (application/octet-stream
    // is common for misconfigured static hosting) used to fall into the HTML branch, whose
    // page.content() would serialize Firefox's PDF-viewer chrome instead of the document —
    // silent content loss for exactly the URLs this feature advertises as supported. The
    // fetch layer (web-scraper.ts) already trusts a `.pdf` URL extension as an equally
    // valid signal; the browser worker must match it.
    const bytes = Buffer.from('%PDF-1.7 mislabeled payload');
    const { context, bodySpy } = makeHarness({
      contentType: 'application/octet-stream',
      body: async () => bytes,
    });
    const result = await executeScrapeTask(context, 'https://mislabeled.example.com/report.pdf');
    expect(result.bufferB64).toBe(bytes.toString('base64'));
    expect(bodySpy).toHaveBeenCalled();
  });
});
