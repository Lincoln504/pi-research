import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetServiceContainer, registerService, ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

// Create shared mocks for browser functions (hoisted for vi.mock)
const { mockRunBrowserTask, mockRunBrowserHealthCheck, mockRunWorkerSearch } = vi.hoisted(() => ({
  mockRunBrowserTask: vi.fn(),
  mockRunBrowserHealthCheck: vi.fn(),
  mockRunWorkerSearch: vi.fn(),
}));

vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: vi.fn().mockImplementation((name) => {
    if (name === 'playwright-core' || name === 'camoufox-js') return true;
    return false;
  }),
}));

vi.mock('../../../src/infrastructure/browser/index.ts', () => ({
  runBrowserTask: mockRunBrowserTask,
  runBrowserHealthCheck: mockRunBrowserHealthCheck,
  runWorkerSearch: mockRunWorkerSearch,
  isBrowserAvailable: vi.fn(() => true),
  getMaxWorkers: vi.fn(() => 2),
  getSchedulerVersion: vi.fn(() => '1.0.0'),
  forceSchedulerRestart: vi.fn(),
}));

// Also mock task-execution-service since that's what web-scraper.ts actually imports
vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserTask: mockRunBrowserTask,
  runBrowserHealthCheck: mockRunBrowserHealthCheck,
  runWorkerSearch: mockRunWorkerSearch,
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock PDF extraction. Records the exact bytes handed to the parser (so tests can
// assert the IPC-safe base64 round-trip delivered real bytes) and throws on an
// empty input, mirroring the real WASM parser — zero bytes cannot be a PDF.
const pdfMockState = vi.hoisted(() => ({ lastBytes: null as Uint8Array | null }));
vi.mock('pdf-oxide-wasm', () => {
  return {
    WasmPdfDocument: class {
      constructor(bytes: Uint8Array) {
        pdfMockState.lastBytes = bytes;
        if (bytes.length === 0) throw new Error('empty or corrupt PDF buffer');
        // Sentinel for the verbose-parser-error regression: a long diagnostic
        // (≥50 words / ≥200 non-ws chars) whose in-band "*Error: ...*" banner
        // used to clear validateContent's stub gate and get cached as content.
        if (Buffer.from(bytes).toString().startsWith('%PDF-CORRUPT')) {
          throw new Error('parse failure: ' + 'very long diagnostic detail '.repeat(12));
        }
      }
      pageCount = () => 1;
      toMarkdown = () => 'PDF content';
      toMarkdownAll = () => 'Full PDF content ' + 'word '.repeat(100);
      free = () => {};
    }
  };
});

vi.mock('@kreuzberg/html-to-markdown-node', () => ({
  convert: vi.fn((html: string) => ({ content: html })),
  HeadingStyle: { Atx: {} },
  CodeBlockStyle: { Backticks: {} },
}));

// Mock SSRF validation so unit tests don't perform real DNS lookups
vi.mock('../../../src/web-research/scraper-utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/web-research/scraper-utils.ts')>();
  return {
    ...original,
    validateUrlForSSRF: vi.fn().mockResolvedValue(undefined),
    // The scrape layer deliberately calls UNDICI's fetch, not the global one — a
    // dispatcher is only honoured by the undici that built it (see
    // getSsrfSafeFetcher). The cases below drive the layer's logic (retry, size
    // caps, cancellation, PDF detection) through vi.stubGlobal('fetch', …), so
    // resolve the implementation lazily to whatever global fetch is stubbed at
    // call time. The REAL undici path is covered against a real socket in
    // scrape-fetch-dispatcher.test.ts — mocking it here is what let a total
    // failure of that path go unnoticed in the first place.
    getSsrfSafeFetcher: vi.fn().mockResolvedValue({
      fetch: (url: string, init: Record<string, unknown>) =>
        (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
      dispatcher: {},
    }),
  };
});

import { scrapeSingle, initScraperDependencies } from '../../../src/web-research/web-scraper.ts';
import { MetricsRegistry, runWithRunRegistry } from '../../../src/utils/metrics.ts';

describe('scrapers', () => {
  let runRegistry: MetricsRegistry;

  beforeEach(() => {
    runRegistry = new MetricsRegistry();
    initScraperDependencies();
    mockRunBrowserTask.mockReset();
    mockRunBrowserHealthCheck.mockReset();
    mockRunWorkerSearch.mockReset();
    // ... rest of beforeEach

    // Register mock scheduler service for browser fallback tests
    registerService(
      ServiceNames.SCHEDULER,
      () => ({
        name: 'scheduler',
        lifecycle: ServiceLifecycle.INITIALIZED,
        async initialize() {},
        async dispose() {},
        async runSearch() { return []; },
        async runScrape() { return { html: '' }; },
        async runHealthCheck() { return { success: true }; },
        async shutdown() {},
        getSchedulerInstance() { return null; },
        schedulerId: 'test',
      }),
      { allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetServiceContainer();
  });

  describe('scrapeSingle — URL validation', () => {
    it('rejects a JSON array accidentally stringified as the url (starts with [) without calling fetch', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await scrapeSingle('["https://a.com","https://b.com"]');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL format');
      expect(result.markdown).toBe('');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does NOT reject a valid URL that merely contains brackets in its query string', async () => {
      // Regression: the old includes('[') guard dropped legit URLs like ?ids[]=1 before any fetch.
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await scrapeSingle('https://example.com/api?ids[]=1');

      // It is not rejected at the bracket guard — it proceeds (SSRF/fetch handle it from here).
      expect(result.error ?? '').not.toContain('Invalid URL format');
    });
  });

  describe('scrapeSingle — fetch layer', () => {
    it('returns success with source=fetch when fetch succeeds', async () => {
      const okHtml = '<h1>Title</h1><p>This is a long enough content to pass the 50 word check. ' +
        ('Word word word word word word word word word word ').repeat(5) + '.</p>';
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => okHtml,
        arrayBuffer: async () => new TextEncoder().encode(okHtml).buffer,
      }));

      const result = await scrapeSingle('https://some-site.org/page');

      expect(result.success).toBe(true);
      expect(result.source).toBe('fetch');
      expect(result.markdown).toContain('Title');
    });

    it('detects and extracts PDF content', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (name: string) => name === 'content-type' ? 'application/pdf' : null },
        arrayBuffer: async () => new ArrayBuffer(8),
      }));

      const result = await scrapeSingle('https://some-site.org/file.pdf');

      expect(result.success).toBe(true);
      expect(result.markdown).toContain('Full PDF content');
    });

    it('fails when bot protection is detected (and browser also fails)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => '<html><head><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/js/CHL_CORE/v1"></script></head></html>',
        arrayBuffer: async () => new TextEncoder().encode('<html><head><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/js/CHL_CORE/v1"></script></head></html>').buffer,
      }));
      
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser also blocked'));

      const result = await scrapeSingle('https://protected-site.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser also blocked');
    });

    it('aborts a chunked over-limit body at the 25MB cap instead of buffering it all (streaming cap)', async () => {
      // Regression: the 25MB gate used to be a Content-Length pre-screen plus a
      // post-arrayBuffer() check — a chunked response with no length header was
      // fully buffered (unbounded memory) before any size check ran. The body
      // must now be read through a hard cap that cancels the stream on breach.
      const CHUNK = new Uint8Array(1024 * 1024); // 1MB
      const TOTAL_CHUNKS = 100; // 100MB on offer
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (pulls > TOTAL_CHUNKS) controller.close();
          else controller.enqueue(CHUNK);
        },
        cancel() { cancelled = true; },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) }, // no content-length
        body,
        arrayBuffer: async () => { throw new Error('must not be called — streaming path required'); },
      }));
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser layer skipped'));

      const result = await scrapeSingle('https://huge-site.org/endless');

      expect(result.success).toBe(false);
      // The stream was cut off at the cap, not drained: ≤27 pulls (~25MB + slack), not 100.
      expect(pulls).toBeLessThanOrEqual(27);
      expect(cancelled).toBe(true);
    });

    it('fails when content is too short (stub detection)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => '<p>Too short.</p>',
        arrayBuffer: async () => new TextEncoder().encode('<p>Too short.</p>').buffer,
      }));

      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser also returned stub'));

      const result = await scrapeSingle('https://other-site.com/stub');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser also returned stub');
    });
  });

  describe('scrapeSingle — fetch-layer transient retry', () => {
    // The fetch layer is the only scrape layer without a retry, and its fallback is
    // a stealth browser render 10–30× more expensive. One cheap retry is worth it —
    // but only for genuinely transient failures, and it must not turn one failure
    // into two tracked errors.
    const okHtml = '<h1>Title</h1><p>' + 'Word word word word word word word word word word '.repeat(6) + '.</p>';
    const okResponse = () => ({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => okHtml,
      arrayBuffer: async () => new TextEncoder().encode(okHtml).buffer,
    });

    it('retries once and succeeds without ever reaching the browser', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }))
        .mockResolvedValue(okResponse());
      vi.stubGlobal('fetch', fetchMock);
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');

      const result = await scrapeSingle('https://some-site.org/blip');

      expect(result.success).toBe(true);
      expect(result.source).toBe('fetch');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The whole point: no browser render was paid for.
      expect(runBrowserTask).not.toHaveBeenCalled();
    });

    it('does NOT retry a non-transient failure (an HTTP 404 is not a blip)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => 'text/html' },
        body: null,
      });
      vi.stubGlobal('fetch', fetchMock);
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser failed'));

      await scrapeSingle('https://some-site.org/missing');

      // One attempt only — retrying a 404 just doubles the latency of every dead link.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('stops retrying when the caller has already aborted', async () => {
      const controller = new AbortController();
      const fetchMock = vi.fn().mockImplementation(async () => {
        controller.abort();
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser failed'));

      await scrapeSingle('https://some-site.org/cancelled', controller.signal);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('files one tracked error per failed URL, not one per attempt', async () => {
      const { errorTracker } = await import('../../../src/utils/error-tracker.ts');
      const trackSpy = vi.spyOn(errorTracker, 'trackError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })));
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser failed'));

      await scrapeSingle('https://some-site.org/always-down');

      // Two fetch attempts were made; tracking them separately would double every
      // fetch-layer error count read during an incident.
      const fetchLayerErrors = trackSpy.mock.calls.filter(
        ([, ctx]) => (ctx as { layer?: string } | undefined)?.layer === 'fetch',
      );
      expect(fetchLayerErrors).toHaveLength(1);
      trackSpy.mockRestore();
    });
  });

  describe('scrapeSingle — browser PDF path (IPC-safe bytes)', () => {
    // Worker PDF bytes cross the poolifier cluster-IPC channel (JSON
    // serialization), where a raw Buffer arrives as {type:'Buffer',data:[...]}
    // and new Uint8Array(that) is ZERO bytes — the extraction then ran on
    // nothing and its "*Error: ...*" string was cached as a success. The worker
    // now ships base64; these tests pin the decode and the failure semantics.
    const PDF_BYTES = Buffer.from('%PDF-1.7 test-bytes éÿ payload');

    beforeEach(() => {
      pdfMockState.lastBytes = null;
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch layer down')));
    });

    it('decodes bufferB64 back to the exact original bytes and succeeds', async () => {
      mockRunBrowserTask.mockResolvedValue({
        contentType: 'application/pdf',
        bufferB64: PDF_BYTES.toString('base64'),
      });

      const result = await scrapeSingle('https://some-site.org/paper.pdf');

      expect(result.success).toBe(true);
      expect(result.markdown).toContain('Full PDF content');
      // The whole point: the parser received the worker's REAL bytes, not zero.
      expect(pdfMockState.lastBytes).not.toBeNull();
      expect(Buffer.from(pdfMockState.lastBytes!).equals(PDF_BYTES)).toBe(true);
    });

    it('still decodes the legacy JSON-roundtripped Buffer shape (mixed-version leader/follower)', async () => {
      // What an old leader hands a new follower: the Buffer after one (or two)
      // JSON hops — {type:'Buffer',data:[...]}.
      mockRunBrowserTask.mockResolvedValue({
        contentType: 'application/pdf',
        buffer: JSON.parse(JSON.stringify(PDF_BYTES)),
      });

      const result = await scrapeSingle('https://some-site.org/legacy.pdf');

      expect(result.success).toBe(true);
      expect(pdfMockState.lastBytes).not.toBeNull();
      expect(Buffer.from(pdfMockState.lastBytes!).equals(PDF_BYTES)).toBe(true);
    });

    it('fails the scrape when extraction throws a VERBOSE parser error (a long banner must never become citable content)', async () => {
      // A diagnostic ≥50 words / ≥200 non-whitespace chars passes validateContent's
      // stub gate, so the old in-band "*Error: Could not extract...*" return was
      // recorded — and cached — as a successful scrape. Extraction failure must throw.
      mockRunBrowserTask.mockResolvedValue({
        contentType: 'application/pdf',
        bufferB64: Buffer.from('%PDF-CORRUPT garbage bytes').toString('base64'),
      });

      const result = await scrapeSingle('https://some-site.org/corrupt.pdf');

      expect(result.success).toBe(false);
      expect(result.markdown).toBe('');
      expect(result.error).toContain('Could not extract content from PDF');
    });

    it('logs a PDF extraction failure at debug, not error — an expected per-URL outcome, not an engine fault', async () => {
      // Regression: extractPdfToMarkdown used to call logger.error unconditionally,
      // before either caller (fetch layer, always-debug-a-fallback-follows; browser
      // layer, isBenignScrapeFailure-gated) got a chance to classify it — an ERROR
      // log on every malformed/encrypted/scanned-only PDF, routine on the open web.
      const { logger } = await import('../../../src/logger.ts');
      vi.mocked(logger.error).mockClear();
      mockRunBrowserTask.mockResolvedValue({
        contentType: 'application/pdf',
        bufferB64: Buffer.from('%PDF-CORRUPT garbage bytes').toString('base64'),
      });

      const result = await scrapeSingle('https://some-site.org/corrupt2.pdf');

      expect(result.success).toBe(false);
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('reports FAILURE when PDF extraction yields an error string (never a cached success)', async () => {
      // Zero decoded bytes is exactly the old bug's symptom: extraction fails,
      // extractPdfToMarkdown returns "*Error: ...*", and the PDF branch used to
      // skip validateContent — reporting success and caching the error string.
      mockRunBrowserTask.mockResolvedValue({
        contentType: 'application/pdf',
        bufferB64: '',
      });

      const result = await scrapeSingle('https://some-site.org/broken.pdf');

      expect(result.success).toBe(false);
      expect(result.markdown).toBe('');
    });
  });

  describe('scrapeSingle / scrape — cancellation', () => {
    it('short-circuits on an already-aborted signal without fetch, browser, or failure metrics', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const controller = new AbortController();
      controller.abort();

      let result: Awaited<ReturnType<typeof scrapeSingle>>;
      await runWithRunRegistry(runRegistry, async () => {
        result = await scrapeSingle('https://example.com/cancelled', controller.signal);
      });

      expect(result!.success).toBe(false);
      expect(result!.error).toBe('Aborted');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
      // A cancellation is not a scrape failure — it must not appear in the
      // run summary's failed-URL tally.
      const snapshot = runRegistry.getSnapshot();
      expect(snapshot.counters['scrape_results_total{outcome="total_failure"}']).toBeUndefined();
    });

    it("classifies a browser-layer 'Aborted' as cancellation: no ERROR log, no total_failure, no tracker entry", async () => {
      const { logger } = await import('../../../src/logger.ts');
      const { errorTracker } = await import('../../../src/utils/error-tracker.ts');
      const trackSpy = vi.spyOn(errorTracker, 'trackError');
      const controller = new AbortController();
      // Fetch fails once the caller aborts; the browser layer then surfaces the
      // codebase's recognized cancellation signature.
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
        controller.abort();
        throw new Error('socket closed');
      }));
      mockRunBrowserTask.mockRejectedValue(new Error('Aborted'));

      let result: Awaited<ReturnType<typeof scrapeSingle>>;
      await runWithRunRegistry(runRegistry, async () => {
        result = await scrapeSingle('https://example.com/mid-cancel', controller.signal);
      });

      expect(result!.success).toBe(false);
      expect(result!.error).toBe('Aborted');
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
      expect(trackSpy).not.toHaveBeenCalled();
      const snapshot = runRegistry.getSnapshot();
      expect(snapshot.counters['scrape_results_total{outcome="total_failure"}']).toBeUndefined();
      trackSpy.mockRestore();
    });

    it('stops dispatching batches once the signal aborts mid-run', async () => {
      const { scrape } = await import('../../../src/web-research/web-scraper.ts');
      const okHtml = '<p>' + 'Word word word word word word word word word word '.repeat(6) + '</p>';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => okHtml,
        arrayBuffer: async () => new TextEncoder().encode(okHtml).buffer,
      });
      vi.stubGlobal('fetch', fetchMock);
      const controller = new AbortController();

      const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4'];
      // maxConcurrency 1 → four sequential batches; cancel after the first result.
      const results = await scrape(urls, 1, controller.signal, undefined, undefined, () => controller.abort());

      // Only the first batch actually ran — the doomed fetch/browser cycle for
      // the remaining URLs was skipped entirely — but every URL still gets an
      // entry: a caller must be able to tell "cancelled after 1 of 4" apart
      // from "4 of 4 accounted for" (regression: the undispatched URLs used to
      // vanish from the returned array with no indication of why).
      expect(results).toHaveLength(4);
      expect(results[0]).toMatchObject({ url: 'https://a.example/1', success: true });
      expect(results.slice(1)).toEqual([
        { url: 'https://a.example/2', success: false, error: 'Aborted', markdown: '' },
        { url: 'https://a.example/3', success: false, error: 'Aborted', markdown: '' },
        { url: 'https://a.example/4', success: false, error: 'Aborted', markdown: '' },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
    });
  });

  describe('scrapeSingle — browser fallback', () => {
    it('falls back to browser when fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));
      
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockResolvedValue({
        html: '<p>Content from browser. ' + 
              'Word word word word word word word word word word ' +
              'word word word word word word word word word word ' +
              'word word word word word word word word word word ' +
              'word word word word word word word word word word ' +
              'word word word word word word word word word word.</p>'
      });

      const result = await scrapeSingle('https://example.com/js-heavy');

      expect(result.success).toBe(true);
      expect(result.source).toBe('playwright');
      expect(result.markdown).toContain('Content from browser');
      expect(runBrowserTask).toHaveBeenCalled();
    });

    it('returns failure if both fetch and browser fail', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Fetch failed')));
      
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser failed'));

      const result = await scrapeSingle('https://example.com/total-fail');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser failed');
    });
  });

  describe('scrapeSingle — metrics', () => {
    it('records fetch_success metric', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => 'Word '.repeat(60),
        arrayBuffer: async () => new TextEncoder().encode('Word '.repeat(60)).buffer,
      }));

      await runWithRunRegistry(runRegistry, async () => {
        await scrapeSingle('https://example.com/m1');
      });

      const snapshot = runRegistry.getSnapshot();
      expect(snapshot.counters['scrape_results_total{outcome="fetch_success"}']).toBe(1);
    });

    it('records browser_success metric', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Fail')));
      mockRunBrowserTask.mockResolvedValue({ html: 'Word '.repeat(60) });

      await runWithRunRegistry(runRegistry, async () => {
        await scrapeSingle('https://example.com/m2');
      });

      const snapshot = runRegistry.getSnapshot();
      expect(snapshot.counters['scrape_results_total{outcome="browser_success"}']).toBe(1);
    });

    it('records total_failure metric', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Fail')));
      mockRunBrowserTask.mockRejectedValue(new Error('Fail'));

      await runWithRunRegistry(runRegistry, async () => {
        await scrapeSingle('https://example.com/m3');
      });

      const snapshot = runRegistry.getSnapshot();
      expect(snapshot.counters['scrape_results_total{outcome="total_failure"}']).toBe(1);
    });
  });
});
