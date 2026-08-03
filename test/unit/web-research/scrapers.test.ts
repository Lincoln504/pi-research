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

// Mock PDF extraction
vi.mock('pdf-oxide-wasm', () => {
  return {
    WasmPdfDocument: class {
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
