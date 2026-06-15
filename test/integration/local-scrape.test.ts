/**
 * Integration Test: Real Browser Scrape against a Local HTTP Server
 *
 * This is the project's only DETERMINISTIC end-to-end browser test. It drives
 * the REAL pipeline — real Camoufox launch → real navigation → real HTML →
 * markdown extraction → scrape-tool formatting — against a localhost server, so
 * it has NO external-network dependency and NO live-network escape hatch.
 *
 * Unlike the live-site scrape tests (Wikipedia etc.), a local server is never
 * "network unavailable", so a genuine cross-platform browser failure on
 * Windows/macOS/Linux surfaces as a real test failure here instead of being
 * masked as a skipped network check. It only skips when the browser itself is
 * genuinely unavailable (camoufox missing / FULL_MOCK_MODE).
 *
 * Loopback scraping is normally blocked by validateUrlForSSRF; the
 * PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE flag (set below and in CI) permits loopback
 * ONLY. Set before setupLifecycle so the browser worker threads — where the
 * SSRF check actually runs — inherit it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createScrapeTool } from '../../src/tools/scrape.ts';
import { setupLifecycle, teardownLifecycle, type TestContext } from './helpers/setup.ts';
import { ToolUsageTracker } from '../../src/utils/tool-usage-tracker.ts';

process.env['PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE'] = 'true';

// A unique token that cannot appear by chance in any browser chrome or error
// page — proves the bytes we served round-tripped through the real extractor.
const UNIQUE_MARKER = 'PiResearchLocalScrapeMarker7f3a91';

// >50 words of real prose so validateContent() does not treat the page as a
// blocked/stub response and reject it.
const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Local Scrape Integration Page</title></head>
<body><main>
<h1>Local Integration Heading</h1>
<p>${UNIQUE_MARKER}. This page is served by a localhost HTTP server purely so the
integration suite can exercise the real browser scrape pipeline without touching
the public internet. The paragraph deliberately contains well over fifty words of
ordinary readable text describing the test so that the content validator accepts
it as a genuine article rather than rejecting it as an empty stub, a captcha
interstitial, or a bot-challenge page. Cross platform browser automation must
extract this sentence faithfully on Linux, macOS, and Windows alike.</p>
</main></body></html>`;

const mockExtensionCtx = {
  cwd: process.cwd(),
  ui: { setWidget: () => {}, notify: () => {} },
};

describe('Real Browser Scrape — Local HTTP Server (cross-platform)', () => {
  let server: Server;
  let baseUrl: string;
  let testContext: TestContext = {
    lifecycleInitialized: false,
    skipTests: () => true,
    init: async () => {},
    shutdown: async () => {},
    beforeEach: async () => {},
    afterEach: async () => {},
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/`;
    testContext = await setupLifecycle();
  });

  afterAll(async () => {
    await teardownLifecycle(testContext);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('launches a real browser and extracts content from a local page', async (ctx) => {
    // Skips ONLY when the browser is genuinely unavailable — never for network
    // reasons, because the target is loopback.
    if (testContext.skipTests()) return ctx.skip();

    const tool = createScrapeTool({
      ctx: mockExtensionCtx as any,
      tracker: new ToolUsageTracker({ scrape: 10 }),
      getGlobalState: () => ({ researchId: 'local-scrape-test' } as any),
      updateGlobalLinks: () => {},
    });

    const result = await tool.execute(
      'local-scrape-1',
      { urls: [baseUrl] },
      undefined,
      undefined,
      mockExtensionCtx as any,
    );

    expect(result.content[0]?.type).toBe('text');
    const text = (result.content[0] as any).text as string;

    // Deterministic assertions — the real browser must have fetched, rendered,
    // and extracted our exact page. No isNetworkUnavailable fallback.
    expect(text).toContain('**Successful:** 1');
    expect(text).not.toContain('**Successful:** 0');
    expect(text).toContain(baseUrl);
    expect(text).toContain('Local Integration Heading');
    expect(text).toContain(UNIQUE_MARKER);

    // The scrape details must agree with the formatted summary.
    expect(result.details).toBeDefined();
    expect((result.details as any).successful).toBe(1);
    expect((result.details as any).failed).toBe(0);
  });
});
