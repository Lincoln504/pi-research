/**
 * Security regression tests for the browser worker's SUBRESOURCE SSRF guard and
 * the response-side DNS-rebinding backstop in executeScrapeTask.
 *
 * The gap these lock in: page.route previously gave navigations the full
 * DNS-aware validateUrlForSSRF but subresources (img/script/xhr/fetch) only the
 * synchronous literal/pattern screen — no DNS resolution. A hostile page whose
 * own navigation DNS-validated as public could therefore fetch() a TTL-0
 * DNS-rebinding hostname that resolves to 169.254.169.254 (cloud metadata) and
 * read the credentials into the DOM that page.content() serializes into the
 * research report. camoufox/Firefox resolves hostnames itself at connect time
 * (no connect-time IP pinning), so the fix is two layers:
 *   (a) request-time: every http(s) subresource hostname gets the same
 *       DNS-aware validator as navigations, deduplicated per hostname by a
 *       short-TTL verdict cache (one resolution per hostname, not per asset);
 *   (b) response-time: every response's serverAddr() — the IP the browser
 *       ACTUALLY connected to — is re-checked; a private/reserved address
 *       poisons the scrape (page closed, benign 'Fetch blocked:' failure).
 *
 * Mirrors ssrf-dns-rebinding.test.ts: mocks node:dns/promises (the module
 * scraper-utils resolves through) — deterministic, fully offline. The browser
 * page/context are minimal mocks; no real browser is launched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock fns so vi.mock's factory (hoisted above the imports) can
// reference them. Each test drives what a hostname "resolves" to.
const { mockResolve4, mockResolve6 } = vi.hoisted(() => ({
  mockResolve4: vi.fn<(host: string) => Promise<string[]>>(),
  mockResolve6: vi.fn<(host: string) => Promise<string[]>>(),
}));

vi.mock('node:dns/promises', () => ({
  resolve4: mockResolve4,
  resolve6: mockResolve6,
}));

import { executeScrapeTask } from '../../../src/infrastructure/browser/thread-worker-messaging.ts';
import { isBenignScrapeFailure } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';
const PUBLIC_IP = '93.184.216.34';
const METADATA_IP = '169.254.169.254';

type RouteHandler = (route: any, req: any) => Promise<void>;

/**
 * Minimal page/context harness implementing exactly the surface
 * executeScrapeTask touches. `gotoEmits` are responses fired to
 * page.on('response') listeners during goto — this is how a subresource
 * response (e.g. a rebound same-origin fetch) is simulated.
 */
function makeHarness(opts: { mainIp?: string | null; gotoEmits?: any[] } = {}) {
  const listeners: Record<string, any[]> = {};
  let routeHandler: RouteHandler | undefined;
  const mainFrame = {};
  const mainResponse = {
    request: () => ({ resourceType: () => 'document' }),
    frame: () => mainFrame,
    serverAddr: async () =>
      opts.mainIp === null ? null : { ipAddress: opts.mainIp ?? PUBLIC_IP, port: 443 },
    headerValue: async () => 'text/html',
    body: async () => Buffer.from('x'),
  };
  // >5000 chars and none of the JS-shell markers, so the needsWait branch stays off.
  const html = `<html><body><p>${'lorem ipsum dolor sit amet '.repeat(300)}</p></body></html>`;
  const page: any = {
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    route: async (_pattern: string, handler: RouteHandler) => {
      routeHandler = handler;
    },
    on: (event: string, handler: any) => {
      (listeners[event] ??= []).push(handler);
    },
    goto: async () => {
      for (const resp of opts.gotoEmits ?? []) {
        for (const h of listeners['response'] ?? []) h(resp);
      }
      for (const h of listeners['response'] ?? []) h(mainResponse);
      return mainResponse;
    },
    content: async () => html,
    waitForLoadState: async () => {},
    close: vi.fn(async () => {}),
    mainFrame: () => mainFrame,
  };
  const context = { newPage: async () => page };
  return { context, page, getRouteHandler: () => routeHandler };
}

/** A subresource (fetch/xhr) response whose connection landed on `ip`. */
function subresourceResponse(ip: string | null) {
  return {
    request: () => ({ resourceType: () => 'fetch' }),
    frame: () => ({}),
    serverAddr: async () => (ip === null ? null : { ipAddress: ip, port: 80 }),
  };
}

function makeRoute() {
  return { abort: vi.fn(async () => {}), fallback: vi.fn(async () => {}) };
}

function makeRequest(url: string, isNavigation: boolean) {
  return { url: () => url, isNavigationRequest: () => isNavigation };
}

describe('executeScrapeTask — subresource SSRF guard + response-side rebinding backstop', () => {
  beforeEach(() => {
    // Zero out the human-behavior jitter so tests are fast (env is read per task).
    process.env['PI_RESEARCH_MOCK_SCRAPE'] = 'true';
    // Default: nothing resolves. Individual tests override per hostname.
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env['PI_RESEARCH_MOCK_SCRAPE'];
    delete process.env[FLAG];
  });

  it('blocks a subresource whose hostname rebinds to the cloud-metadata address (request-time DNS)', async () => {
    const { context, getRouteHandler } = makeHarness();
    const result = await executeScrapeTask(context, 'https://public-site-a.example.com/');
    expect(result.html).toBeDefined();

    // The hostile page fetch()es a host that NOW resolves to 169.254.169.254.
    mockResolve4.mockResolvedValue([METADATA_IP]);
    const route = makeRoute();
    await getRouteHandler()!(route, makeRequest('http://rebound-a.attacker.example/steal', false));
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.fallback).not.toHaveBeenCalled();
  });

  it('blocks a subresource whose hostname resolves to RFC1918 / IPv6-private space', async () => {
    const { context, getRouteHandler } = makeHarness();
    await executeScrapeTask(context, 'https://public-site-b.example.com/');
    const handler = getRouteHandler()!;

    mockResolve4.mockResolvedValue(['10.0.0.5']);
    const route1 = makeRoute();
    await handler(route1, makeRequest('http://rebound-b1.attacker.example/x.js', false));
    expect(route1.abort).toHaveBeenCalledWith('blockedbyclient');

    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue(['fc00::1']);
    const route2 = makeRoute();
    await handler(route2, makeRequest('http://rebound-b2.attacker.example/x.js', false));
    expect(route2.abort).toHaveBeenCalledWith('blockedbyclient');
  });

  it('lets a normal public subresource through (fallback, no abort)', async () => {
    const { context, getRouteHandler } = makeHarness();
    await executeScrapeTask(context, 'https://public-site-c.example.com/');

    mockResolve4.mockResolvedValue([PUBLIC_IP]);
    const route = makeRoute();
    await getRouteHandler()!(route, makeRequest('https://cdn-c.example.net/lib.js', false));
    expect(route.fallback).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
  });

  it('resolves each subresource hostname ONCE per TTL (verdict cache — no per-asset DNS stall)', async () => {
    const { context, getRouteHandler } = makeHarness();
    await executeScrapeTask(context, 'https://public-site-d.example.com/');
    const handler = getRouteHandler()!;

    mockResolve4.mockResolvedValue([PUBLIC_IP]);
    for (let i = 0; i < 5; i++) {
      const route = makeRoute();
      await handler(route, makeRequest(`https://cdn-d.example.net/asset-${i}.png`, false));
      expect(route.fallback).toHaveBeenCalled();
    }
    const lookups = mockResolve4.mock.calls.filter(([host]) => host === 'cdn-d.example.net');
    expect(lookups).toHaveLength(1);
  });

  it('seeds the verdict cache from a validated navigation: same-origin assets pay no second resolution', async () => {
    const { context, getRouteHandler } = makeHarness();
    await executeScrapeTask(context, 'https://public-site-e.example.com/');
    const handler = getRouteHandler()!;

    mockResolve4.mockResolvedValue([PUBLIC_IP]);
    const navRoute = makeRoute();
    await handler(navRoute, makeRequest('https://seeded-e.example.org/page', true));
    expect(navRoute.fallback).toHaveBeenCalled();

    const subRoute = makeRoute();
    await handler(subRoute, makeRequest('https://seeded-e.example.org/api/data', false));
    expect(subRoute.fallback).toHaveBeenCalled();

    const lookups = mockResolve4.mock.calls.filter(([host]) => host === 'seeded-e.example.org');
    expect(lookups).toHaveLength(1); // the navigation's own validation only
  });

  it('keeps the loopback test affordance: a loopback subresource passes WITHOUT DNS when the flag is set', async () => {
    process.env[FLAG] = 'true';
    const { context, getRouteHandler } = makeHarness();
    await executeScrapeTask(context, 'https://public-site-f.example.com/');

    const route = makeRoute();
    await getRouteHandler()!(route, makeRequest('http://127.0.0.1:8080/fixture.js', false));
    expect(route.fallback).toHaveBeenCalled();
    expect(route.abort).not.toHaveBeenCalled();
    // The sync screen accepted it definitively — a DNS pass would wrongly reject it.
    expect(mockResolve4).not.toHaveBeenCalled();
  });

  it('poisons the scrape when a subresource RESPONSE was served from the metadata address (rebinding backstop)', async () => {
    // Request-time DNS said "public" (TTL-0 rebind), but the browser's own
    // connect-time resolution landed on 169.254.169.254 — serverAddr() exposes
    // the IP it ACTUALLY connected to, and the scrape must discard everything.
    const { context, page } = makeHarness({
      gotoEmits: [subresourceResponse(METADATA_IP)],
    });

    const err: unknown = await executeScrapeTask(context, 'https://public-site-g.example.com/').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Fetch blocked:.*private\/reserved address/);
    // Benign-classified: an expected per-URL outcome, not an ERROR-level engine fault.
    expect(isBenignScrapeFailure(err)).toBe(true);
    // The poison aborts the page load.
    expect(page.close).toHaveBeenCalled();
  });

  it('poisons the scrape when a subresource response came from a loopback address (flag off)', async () => {
    const { context } = makeHarness({ gotoEmits: [subresourceResponse('127.0.0.1')] });
    await expect(
      executeScrapeTask(context, 'https://public-site-h.example.com/'),
    ).rejects.toThrow(/^Fetch blocked:/);
  });

  it('does NOT poison a loopback-served response when the loopback test flag is set', async () => {
    process.env[FLAG] = 'true';
    const { context } = makeHarness({
      mainIp: '127.0.0.1',
      gotoEmits: [subresourceResponse('127.0.0.1')],
    });
    const result = await executeScrapeTask(context, 'http://127.0.0.1:8080/');
    expect(result.html).toContain('lorem ipsum');
  });

  it('does not poison a scrape whose responses are all public or without serverAddr (cached/fulfilled)', async () => {
    const { context } = makeHarness({
      gotoEmits: [subresourceResponse(PUBLIC_IP), subresourceResponse(null)],
    });
    const result = await executeScrapeTask(context, 'https://public-site-i.example.com/');
    expect(result.html).toContain('lorem ipsum');
    expect(result.contentType).toContain('text/html');
  });
});
