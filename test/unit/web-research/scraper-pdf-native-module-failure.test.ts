/**
 * extractPdfToMarkdown — pdf-oxide-wasm native-module load failure vs a
 * routine per-PDF parse failure.
 *
 * Regression: both used to share one catch block, logged at `debug` and
 * classified as the routine 'Could not extract content from PDF' outcome
 * (isBenignScrapeFailure-matched). A load failure (missing prebuilt binary
 * for this platform, corrupted install) means PDF extraction is broken for
 * EVERY url, not just this one — an infrastructure fault that must surface
 * at ERROR with its own metric label, not be silently swept into the same
 * bucket as a malformed/encrypted PDF.
 *
 * Mirrors the harness in scrapers.test.ts's "browser PDF path" describe
 * block, but with pdf-oxide-wasm mocked to always throw on import — kept in
 * its own file since vi.mock('pdf-oxide-wasm', ...) factories run once per
 * module graph and can't be toggled between throwing/succeeding mid-suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetServiceContainer, registerService, ServiceLifecycle } from '../../../src/core/service-registry.ts';
import { ServiceNames } from '../../../src/core/service-interfaces.ts';

const { mockRunBrowserTask } = vi.hoisted(() => ({ mockRunBrowserTask: vi.fn() }));

vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: vi.fn().mockImplementation((name) => {
    if (name === 'playwright-core' || name === 'camoufox-js') return true;
    return false;
  }),
}));

vi.mock('../../../src/infrastructure/browser/index.ts', () => ({
  runBrowserTask: mockRunBrowserTask,
  runBrowserHealthCheck: vi.fn(),
  runWorkerSearch: vi.fn(),
  isBrowserAvailable: vi.fn(() => true),
  getMaxWorkers: vi.fn(() => 2),
  getSchedulerVersion: vi.fn(() => '1.0.0'),
  forceSchedulerRestart: vi.fn(),
}));

vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserTask: mockRunBrowserTask,
  runBrowserHealthCheck: vi.fn(),
  runWorkerSearch: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Simulates a broken/missing native install: every dynamic import() of
// pdf-oxide-wasm rejects.
vi.mock('pdf-oxide-wasm', () => {
  throw new Error("Cannot find module 'pdf-oxide-wasm'");
});

vi.mock('@kreuzberg/html-to-markdown-node', () => ({
  convert: vi.fn((html: string) => ({ content: html })),
  HeadingStyle: { Atx: {} },
  CodeBlockStyle: { Backticks: {} },
}));

vi.mock('../../../src/web-research/scraper-utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/web-research/scraper-utils.ts')>();
  return {
    ...original,
    validateUrlForSSRF: vi.fn().mockResolvedValue(undefined),
  };
});

import { scrapeSingle, initScraperDependencies } from '../../../src/web-research/web-scraper.ts';
import { isBenignScrapeFailure } from '../../../src/web-research/scraper-utils.ts';
import { logger } from '../../../src/logger.ts';
import { MetricsRegistry, runWithRunRegistry } from '../../../src/utils/metrics.ts';

describe('extractPdfToMarkdown — pdf-oxide-wasm native module unavailable', () => {
  let runRegistry: MetricsRegistry;

  beforeEach(() => {
    runRegistry = new MetricsRegistry();
    initScraperDependencies();
    mockRunBrowserTask.mockReset();
    vi.mocked(logger.error).mockClear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch layer down')));

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

  it('logs at ERROR (not debug) and is NOT classified as a benign per-PDF outcome', async () => {
    mockRunBrowserTask.mockResolvedValue({
      contentType: 'application/pdf',
      bufferB64: Buffer.from('%PDF-1.7 whatever bytes').toString('base64'),
    });

    const result = await runWithRunRegistry(runRegistry, () => scrapeSingle('https://some-site.org/paper.pdf'));

    expect(result.success).toBe(false);
    // Unlike a routine parse failure, a native-module load failure must
    // surface — the whole point of separating the two catch blocks.
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
    expect(isBenignScrapeFailure(new Error(result.error))).toBe(false);
    // Must NOT be described as the routine per-PDF outcome.
    expect(result.error).not.toContain('Could not extract content from PDF');
  });
});
