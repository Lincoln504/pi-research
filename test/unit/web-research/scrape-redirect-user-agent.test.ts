/**
 * One User-Agent per scrape, not one per redirect hop.
 *
 * The fetch scrape path follows 3xx redirects manually (so each hop can be
 * SSRF-validated). The UA header was picked by getRandomUserAgent() INSIDE that
 * loop, so a single scrape could present as Chrome on Windows for the first hop
 * and Firefox on macOS for the next. No browser does that, so the rotation meant
 * to blend in was handing out a distinctive signal instead — on exactly the
 * multi-hop requests (consent gates, tracking redirectors) where bot detection
 * is most attentive.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/web-research/utils.ts', () => ({
  checkModule: () => false, // no playwright/camoufox — keep this on the fetch path
}));

// A distinct UA per call, so a per-hop pick is unmistakable in the assertion.
let uaCounter = 0;
vi.mock('../../../src/web-research/scraper-utils.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/web-research/scraper-utils.ts')>()),
  getRandomUserAgent: () => `TestAgent/${++uaCounter}`,
  // The scrape layer calls undici's fetch, not the global one (see
  // getSsrfSafeFetcher). Defer to the stub this test installs so the assertion
  // is about UA stability across hops, not about the transport.
  getSsrfSafeFetcher: async () => ({
    fetch: (url: string, init: Record<string, unknown>) =>
      (globalThis.fetch as unknown as (u: string, i: unknown) => Promise<Response>)(url, init),
    dispatcher: {},
  }),
}));

const { scrapeSingle } = await import('../../../src/web-research/web-scraper.ts');

const BODY =
  '<h1>Destination</h1><p>This is a long enough content to pass the fifty word check. ' +
  'Word word word word word word word word word word '.repeat(5) +
  '.</p>';

describe('fetch scrape — User-Agent across a redirect chain', () => {
  beforeEach(() => {
    uaCounter = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the SAME User-Agent on every hop of one redirect chain', async () => {
    const sentAgents: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      sentAgents.push(init?.headers?.['User-Agent']);
      if (sentAgents.length === 1) {
        return {
          status: 302,
          ok: false,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? '/second' : null) },
          body: { cancel: async () => {} },
        };
      }
      if (sentAgents.length === 2) {
        return {
          status: 301,
          ok: false,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? '/third' : null) },
          body: { cancel: async () => {} },
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => BODY,
        arrayBuffer: async () => new TextEncoder().encode(BODY).buffer,
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scrapeSingle('https://some-site.invalid/first');

    expect(result.success).toBe(true);
    expect(sentAgents).toHaveLength(3);
    // Pre-fix this was ['TestAgent/1', 'TestAgent/2', 'TestAgent/3'].
    expect(new Set(sentAgents).size).toBe(1);
    expect(sentAgents[0]).toBe('TestAgent/1');
  });
});
