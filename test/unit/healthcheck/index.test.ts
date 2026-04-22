/**
 * Health Check Unit Tests
 *
 * Tests the health check module with mocked dependencies.
 * Focuses on logic, caching, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck, clearHealthCheckCache } from '../../../src/healthcheck/index.ts';
import { logger } from '../../../src/logger.ts';
import { setFallbackSearchEnabled } from '../../../src/web-research/utils.ts';

// Mock dependencies
vi.mock('../../../src/logger.ts', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../../src/infrastructure/searxng-lifecycle.ts', () => ({
  getManager: vi.fn(() => ({})), // Mock manager
}));

vi.mock('../../../src/web-research/search.ts', () => ({
  search: vi.fn(),
}));

vi.mock('../../../src/web-research/scrapers.ts', () => ({
  scrapeSingle: vi.fn(),
}));

vi.mock('../../../src/web-research/utils.ts', () => ({
  setSearxngManager: vi.fn(),
  setFallbackSearchEnabled: vi.fn(),
  filterRelevantResults: vi.fn().mockImplementation((_query, results) => results)
}));

vi.mock('../../../src/utils/searxng-config.ts', () => ({
  getActiveSearxngEngines: vi.fn(() => ['google', 'bing']),
}));

vi.mock('../../../src/web-research/retry-utils.ts', () => ({
  withTimeout: vi.fn((promise) => promise), // Transparent by default
}));

describe('healthcheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthCheckCache();
    process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] = undefined;
  });

  it('should pass health check when search and scrape are healthy', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(search).mockResolvedValue([
      {
        query: 'open source software',
        results: [
          { engine: 'google', title: 'Open Source Software Guide', url: 'u1', content: 'Comprehensive guide to open source software' },
          { engine: 'bing', title: 'What is Open Source?', url: 'u2', content: 'Learning about open source development' },
        ],
      },
    ]);

    vi.mocked(scrapeSingle).mockResolvedValue({
      url: 'https://en.wikipedia.org/wiki/Python_(programming_language)',
      markdown: 'This is a substantial piece of markdown content with more than 10 characters.',
      source: 'searxng',
    } as any);

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(result.scrapeOk).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should pass via fallback when search returns no results from general engines', async () => {
    const { search } = await import('../../../src/web-research/search.ts');

    vi.mocked(search).mockResolvedValue([
      {
        query: 'open source software',
        results: [
          { engine: 'wikipedia', title: 't1', url: 'u1', content: 'c1' },
        ],
      },
    ]);

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.searchOk).toBe(true);
    expect(setFallbackSearchEnabled).toHaveBeenCalledWith(true);
  });

  it('should fail when all scrape canaries return empty content', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(search).mockResolvedValue([
      {
        query: 'open source software',
        results: [{ engine: 'google', title: 'Open Source Projects', url: 'u1', content: 'Explore top open source projects' }],
      },
    ]);

    // All canaries return empty content
    vi.mocked(scrapeSingle).mockResolvedValue({
      url: 'https://en.wikipedia.org/wiki/Python',
      markdown: '   ', // Empty/whitespace
      source: 'searxng',
    } as any);

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.scrapeOk).toBe(false);
    expect(result.error).toContain('Scrape failed on all canary URLs');
  });

  it('should pass when first canary fails but second succeeds', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(search).mockResolvedValue([
      {
        query: 'open source software',
        results: [{ engine: 'google', title: 'Open Source Projects', url: 'u1', content: 'Explore top open source projects' }],
      },
    ]);

    vi.mocked(scrapeSingle)
      .mockResolvedValueOnce({ url: 'c1', markdown: '', source: 'failed' } as any) // first canary fails
      .mockResolvedValue({ url: 'c2', markdown: 'Substantial readable content here', source: 'searxng' } as any);

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(result.scrapeOk).toBe(true);
  });

  it('should skip health check if PI_RESEARCH_SKIP_HEALTHCHECK is set', async () => {
    process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] = '1';

    const result = await runHealthCheck();

    expect(result.success).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Skipping health check'));
  });

  it('should use cached result for subsequent calls within TTL', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    const { scrapeSingle } = await import('../../../src/web-research/scrapers.ts');

    vi.mocked(search).mockResolvedValue([{ query: 'open source software', results: [{ engine: 'google', title: 'Open Source', url: 'u', content: 'Open source content' }] }]);
    vi.mocked(scrapeSingle).mockResolvedValue({ url: 'u', markdown: 'Substantial content', source: 'searxng' } as any);

    // First call
    await runHealthCheck();
    expect(search).toHaveBeenCalledTimes(1);

    // Second call
    await runHealthCheck();
    expect(search).toHaveBeenCalledTimes(1); // Should be cached
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Using cached health check result'));
  });

  it('should handle unexpected errors during health check', async () => {
    const { search } = await import('../../../src/web-research/search.ts');
    vi.mocked(search).mockRejectedValue(new Error('Unexpected crash'));

    const result = await runHealthCheck();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Search request failed: Unexpected crash');
  });
});
