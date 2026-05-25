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

// Also mock task-execution-service since that's what scrapers.ts actually imports
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
  convertWithVisitor: vi.fn(async (html: string) => html),
  JsHeadingStyle: { Atx: {} },
  JsCodeBlockStyle: { Backticks: {} },
}));

import { scrapeSingle, scrape, getDependencyStatus, initScraperDependencies } from '../../../src/web-research/scrapers.ts';

describe('scrapers', () => {
  beforeEach(() => {
    initScraperDependencies();
    mockRunBrowserTask.mockReset();
    mockRunBrowserHealthCheck.mockReset();
    mockRunWorkerSearch.mockReset();

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
      { lazyInitialization: false, allowOverwrite: true, enableLogging: false }
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    resetServiceContainer();
  });

  describe('scrapeSingle — URL validation', () => {
    it('rejects URL containing [ bracket without calling fetch', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const result = await scrapeSingle('https://example.com/[invalid]');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL format');
      expect(result.markdown).toBe('');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('scrapeSingle — fetch layer', () => {
    it('returns success with source=fetch when fetch succeeds', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<h1>Title</h1><p>This is a long enough content to pass the 50 word check. ' + 
                          'Word word word word word word word word word word ' +
                          'word word word word word word word word word word ' +
                          'word word word word word word word word word word ' +
                          'word word word word word word word word word word ' +
                          'word word word word word word word word word word.</p>',
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
      }));
      
      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser also blocked'));

      const result = await scrapeSingle('https://protected-site.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser also blocked');
    });

    it('fails when content is too short (stub detection)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: async () => '<p>Too short.</p>',
      }));

      const { runBrowserTask } = await import('../../../src/infrastructure/browser/index.ts');
      vi.mocked(runBrowserTask).mockRejectedValue(new Error('Browser also returned stub'));

      const result = await scrapeSingle('https://other-site.com/stub');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Browser also returned stub');
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
});
