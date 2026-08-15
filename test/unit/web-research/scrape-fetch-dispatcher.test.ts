/**
 * The fetch scrape layer must actually work — against a real socket.
 *
 * Every other test of this layer mocks `fetch`, which is exactly why a total
 * failure of it went unnoticed: `getSsrfSafeDispatcher()` handed an undici-8
 * `Agent` to Node's GLOBAL fetch, which is backed by the undici built into the
 * runtime (6.21.0 on Node 22, 7.24.4 on Node 25). Cross-major dispatchers are
 * rejected — `UND_ERR_INVALID_ARG: invalid onRequestStart method` — so in
 * production every fetch threw instantly, each URL was retried once and then
 * fell back to the stealth browser (~4.5s per page against ~250ms), and the
 * connect-time SSRF pin the dispatcher exists for never ran once. The browser
 * fallback hid all of it: scrapes still succeeded, just 15-20x slower.
 *
 * So this test uses a REAL loopback HTTP server and the REAL fetch path, with
 * the browser layer unavailable so nothing can mask a failure.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Permit loopback targets — the flag exists for exactly this kind of test.
process.env['PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE'] = 'true';

vi.mock('../../../src/logger.ts', () => ({
  logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// No playwright/camoufox: the browser fallback must not be able to rescue a
// broken fetch layer and turn this test green.
vi.mock('../../../src/web-research/utils.ts', () => ({ checkModule: () => false }));

const { scrapeSingle } = await import('../../../src/web-research/web-scraper.ts');

const MARKER = 'PiResearchFetchDispatcherMarker5b2e';
const PAGE =
  `<!DOCTYPE html><html><head><title>t</title></head><body><main>` +
  `<h1>Heading</h1><p>${MARKER}. This paragraph carries well over fifty words of ` +
  `ordinary readable prose so the content validator treats the response as a real ` +
  `article instead of rejecting it as an empty stub, a captcha interstitial or a ` +
  `bot-challenge page. ` +
  'filler word here '.repeat(20) +
  `</p></main></body></html>`;

let server: Server;
let base = '';

describe('fetch scrape layer — real socket, real dispatcher', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if ((req.url || '/') === '/redirect') {
        res.writeHead(302, { Location: '/redirected' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('fetches and extracts a page without falling back to the browser', async () => {
    const result = await scrapeSingle(`${base}/`);

    // Pre-fix this was success=false with
    // "fetch failed ← invalid onRequestStart method [UND_ERR_INVALID_ARG]".
    expect(result.error ?? '').not.toMatch(/onRequestStart|UND_ERR_INVALID_ARG/);
    expect(result.success).toBe(true);
    expect(result.source).toBe('fetch');
    expect(result.markdown ?? '').toContain(MARKER);
  }, 60_000);

  it('follows a redirect on the fetch path', async () => {
    const result = await scrapeSingle(`${base}/redirect`);

    expect(result.success).toBe(true);
    expect(result.source).toBe('fetch');
    expect(result.markdown ?? '').toContain(MARKER);
  }, 60_000);
});
