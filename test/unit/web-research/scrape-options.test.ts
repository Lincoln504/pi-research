/**
 * scrapeSingle — opt-in ScrapeOptions (httpsOnly, rawText, keepHtml, browserFallback)
 * and the finalUrl / redirects metadata.
 *
 * These options exist for the main-agent fetch_url tool. Research scrapes pass no
 * options and must behave exactly as before; the defaults are asserted too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Browser layer available, but fully mocked: each test decides what it returns.
vi.mock('../../../src/web-research/utils.ts', () => ({ checkModule: () => true }));
const { mockRunBrowserTask } = vi.hoisted(() => ({ mockRunBrowserTask: vi.fn() }));
vi.mock('../../../src/infrastructure/browser/task-execution-service.ts', () => ({
  runBrowserTask: mockRunBrowserTask,
}));

vi.mock('../../../src/web-research/scraper-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web-research/scraper-utils.ts')>()),
  // Transport-agnostic: the tests stub global fetch; SSRF is covered elsewhere.
  validateUrlForSSRF: async () => {},
  getSsrfSafeFetcher: async () => ({
    fetch: (url: string, init: Record<string, unknown>) =>
      (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
    dispatcher: {},
  }),
}));

const { scrapeSingle, isRawTextType } = await import('../../../src/web-research/web-scraper.ts');

const LONG_HTML =
  '<h1>Destination</h1><p>This is a long enough content to pass the fifty word check. ' +
  'Word word word word word word word word word word '.repeat(6) +
  '.</p>';

function redirect(location: string) {
  return {
    status: 302,
    ok: false,
    headers: { get: (n: string) => (n.toLowerCase() === 'location' ? location : null) },
    body: { cancel: vi.fn(async () => {}) },
  };
}

function ok(body: string, contentType: string) {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    ok: true,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    body: null,
    arrayBuffer: async () => bytes.buffer,
    text: async () => body,
  };
}

/** Serve a scripted sequence of responses, one per fetch call. */
function serve(...responses: unknown[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('scrapeSingle — ScrapeOptions', () => {
  beforeEach(() => {
    mockRunBrowserTask.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('finalUrl / redirects metadata', () => {
    it('reports the redirect chain and the final URL', async () => {
      serve(redirect('https://b.example/two'), redirect('/three'), ok(LONG_HTML, 'text/html; charset=utf-8'));
      const r = await scrapeSingle('https://a.example/one');
      expect(r.success).toBe(true);
      expect(r.redirects).toEqual(['https://b.example/two', 'https://b.example/three']);
      expect(r.finalUrl).toBe('https://b.example/three');
      expect(r.contentType).toBe('text/html');
      expect(r.html).toBeUndefined(); // keepHtml not requested
    });
  });

  describe('httpsOnly', () => {
    it('refuses a non-https request URL before any network call', async () => {
      const calls = serve();
      const r = await scrapeSingle('http://a.example/', undefined, undefined, undefined, undefined, { httpsOnly: true });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/non-https URL/);
      expect(calls).toHaveLength(0);
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
    });

    it('refuses an https→http redirect and does NOT fall back to the browser', async () => {
      const calls = serve(redirect('http://a.example/insecure'));
      const r = await scrapeSingle('https://a.example/', undefined, undefined, undefined, undefined, { httpsOnly: true });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/redirect to a non-https URL: http:\/\/a\.example\/insecure/);
      expect(calls).toHaveLength(1); // the insecure hop is never requested
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
    });

    it('still follows https→http redirects when httpsOnly is not set (research default)', async () => {
      serve(redirect('http://a.example/plain'), ok(LONG_HTML, 'text/html'));
      const r = await scrapeSingle('https://a.example/');
      expect(r.success).toBe(true);
      expect(r.finalUrl).toBe('http://a.example/plain');
    });

    it('refuses a browser result whose final URL is http', async () => {
      serve(ok('', 'text/html')); // empty page → stub → browser fallback
      mockRunBrowserTask.mockResolvedValue({ contentType: 'text/html', html: LONG_HTML, finalUrl: 'http://a.example/after-js' });
      const r = await scrapeSingle('https://a.example/', undefined, undefined, undefined, undefined, { httpsOnly: true });
      expect(mockRunBrowserTask).toHaveBeenCalledTimes(1);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/ended on a non-https URL/);
    });

    it('accepts a browser result on https and reports its final URL', async () => {
      serve(ok('', 'text/html'));
      mockRunBrowserTask.mockResolvedValue({ contentType: 'text/html', html: LONG_HTML, finalUrl: 'https://a.example/rendered' });
      const r = await scrapeSingle('https://a.example/', undefined, undefined, undefined, undefined, { httpsOnly: true, keepHtml: true });
      expect(r.success).toBe(true);
      expect(r.layer).toBe('playwright+camoufox');
      expect(r.finalUrl).toBe('https://a.example/rendered');
      expect(r.html).toBe(LONG_HTML);
    });
  });

  describe('rawText', () => {
    it('returns JSON verbatim (pretty-printed), even when short', async () => {
      serve(ok('{"a":1,"b":[true,null]}', 'application/json; charset=utf-8'));
      const r = await scrapeSingle('https://api.example/x', undefined, undefined, undefined, undefined, { rawText: true });
      expect(r.success).toBe(true);
      expect(r.raw).toBe(true);
      expect(r.contentType).toBe('application/json');
      expect(r.markdown).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
    });

    it('keeps Markdown bodies exactly as served (embedded HTML included)', async () => {
      const md = '<p align="center"><a href="docs/x.md">Docs</a></p>\n\n# Title\n\n    indented code\n';
      serve(ok(md, 'text/plain; charset=utf-8'));
      const r = await scrapeSingle('https://raw.example/README.md', undefined, undefined, undefined, undefined, { rawText: true });
      expect(r.markdown).toBe(md);
      expect(r.raw).toBe(true);
    });

    it('leaves unparseable JSON unchanged', async () => {
      serve(ok('{not json', 'application/json'));
      const r = await scrapeSingle('https://api.example/x', undefined, undefined, undefined, undefined, { rawText: true });
      expect(r.markdown).toBe('{not json');
    });

    it('still converts HTML to Markdown', async () => {
      serve(ok(LONG_HTML, 'text/html'));
      const r = await scrapeSingle('https://a.example/', undefined, undefined, undefined, undefined, { rawText: true, keepHtml: true });
      expect(r.raw).toBeUndefined();
      expect(r.markdown).toContain('# Destination');
      expect(r.html).toBe(LONG_HTML);
    });

    it('recognises text-like types', () => {
      for (const t of ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'application/vnd.api+json', 'application/atom+xml', 'application/yaml']) {
        expect(isRawTextType(t)).toBe(true);
      }
      for (const t of ['text/html', 'application/xhtml+xml', 'application/pdf', 'image/png', '']) {
        expect(isRawTextType(t)).toBe(false);
      }
    });
  });

  describe('browserFallback', () => {
    it('falls back to the browser by default', async () => {
      serve(ok('', 'text/html'));
      mockRunBrowserTask.mockResolvedValue({ contentType: 'text/html', html: LONG_HTML });
      const r = await scrapeSingle('https://a.example/');
      expect(r.success).toBe(true);
      expect(mockRunBrowserTask).toHaveBeenCalledTimes(1);
    });

    it('does not use the browser when browserFallback is false', async () => {
      serve(ok('', 'text/html'));
      const r = await scrapeSingle('https://a.example/', undefined, undefined, undefined, undefined, { browserFallback: false });
      expect(r.success).toBe(false);
      expect(mockRunBrowserTask).not.toHaveBeenCalled();
    });
  });
});
