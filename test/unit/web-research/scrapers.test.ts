import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: vi.fn().mockReturnValue(false), // playwright unavailable
}));

vi.mock('../../../src/infrastructure/browser-manager.ts', () => ({
  runBrowserTask: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@kreuzberg/html-to-markdown-node', () => ({
  convertWithVisitor: vi.fn(async (html: string) => html),
  JsHeadingStyle: { Atx: {} },
  JsCodeBlockStyle: { Backticks: {} },
}));

import { scrapeSingle, scrape, getDependencyStatus } from '../../../src/web-research/scrapers.ts';

describe('scrapers', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
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

    it('rejects URL containing ] bracket', async () => {
      vi.stubGlobal('fetch', vi.fn());
      const result = await scrapeSingle('https://example.com/path]');
      expect(result.success).toBe(false);
    });
  });

  describe('scrapeSingle — fetch layer', () => {
    it('returns success with source=fetch when fetch succeeds', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => '<p>Hello world</p>',
      }));

      const result = await scrapeSingle('https://example.com/page');

      expect(result.success).toBe(true);
      expect(result.url).toBe('https://example.com/page');
      expect(result.source).toBe('fetch');
      expect(typeof result.markdown).toBe('string');
    });

    it('preserves the url field in both success and failure results', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => 'text/html' },
      }));

      const result = await scrapeSingle('https://example.com/missing');
      expect(result.url).toBe('https://example.com/missing');
    });

    it('returns failure and error message when fetch returns HTTP error status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => 'text/html' },
      }));

      const result = await scrapeSingle('https://example.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('HTTP 403');
      expect(result.markdown).toBe('');
    });

    it('returns failure when fetch throws a network error and playwright is unavailable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

      expect(getDependencyStatus().playwrightAvailable).toBe(false);

      const result = await scrapeSingle('https://example.com/page');

      expect(result.success).toBe(false);
      expect(result.error).toContain('connection refused');
      expect(result.markdown).toBe('');
    });
  });

  describe('scrape (batch)', () => {
    it('returns empty array for empty URL list without calling fetch', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const results = await scrape([]);

      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns one result per URL', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => 'text/html' },
      }));

      const results = await scrape([
        'https://example.com/a',
        'https://example.com/b',
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].url).toBe('https://example.com/a');
      expect(results[1].url).toBe('https://example.com/b');
    });

    it('continues processing remaining URLs after one fails', async () => {
      vi.stubGlobal('fetch', vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          headers: { get: () => 'text/html' },
          text: async () => '<p>success content</p>',
        }),
      );

      const results = await scrape([
        'https://example.com/fail',
        'https://example.com/success',
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(false);
      expect(results[1].success).toBe(true);
    });
  });
});
