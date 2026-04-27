
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck, clearHealthCheckCache } from '../../../src/healthcheck/index.ts';
import { isBrowserAvailable, runBrowserHealthCheck } from '../../../src/infrastructure/browser-manager.ts';
import { scrapeSingle } from '../../../src/web-research/scrapers.ts';

// Mock dependencies
vi.mock('../../../src/config.ts', () => ({
  getConfig: () => ({ HEALTH_CHECK_TIMEOUT_MS: 25000 }),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/browser-manager.ts', () => ({
  isBrowserAvailable: vi.fn(),
  runBrowserHealthCheck: vi.fn(),
}));

vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrapeSingle: vi.fn(),
}));

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthCheckCache();
  });

  it('should pass health check when browser, search and scrape are healthy', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(scrapeSingle).mockResolvedValue({
      success: true,
      url: 'https://en.wikipedia.org/wiki/Main_Page',
      markdown: 'A'.repeat(600),
      source: 'fetch',
      layer: 'fetch'
    });

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.scrapeOk).toBe(true);
  });

  it('should fail when browser is not available', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(false);

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Browser binaries');
  });

  it('should fail when search validation fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: false });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.searchOk).toBe(false);
    expect(result.error).toContain('Search validation failed');
  });

  it('should fail when scrape validation fails', async () => {
    vi.mocked(isBrowserAvailable).mockReturnValue(true);
    vi.mocked(runBrowserHealthCheck).mockResolvedValue({ success: true });
    vi.mocked(scrapeSingle).mockResolvedValue({
      success: false,
      url: 'any',
      markdown: 'too short',
      source: 'fetch',
      layer: 'fetch'
    });

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.scrapeOk).toBe(false);
    expect(result.error).toContain('Scrape verification failed');
  });
});
