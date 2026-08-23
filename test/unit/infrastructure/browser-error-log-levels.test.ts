/**
 * Two attempt-level sites that reported recovered conditions as terminal faults.
 *
 * Both were measured against a real run log, where every occurrence was followed
 * immediately by a successful recovery:
 *
 *  - BrowserServer logged every handler failure at ERROR, including the routine
 *    per-URL scrape outcomes (HTTP 4xx/5xx, navigation timeout, oversized PDF) that
 *    the client side already classifies as expected. The leader saw each failure
 *    first, so the client's classification never prevented the ERROR.
 *  - BrowserClient logged ERROR and tracked an error for a socket failure the caller
 *    is about to retry — a leader handover is ECONNREFUSED against the departing
 *    leader's port and recovers within a second. 5 of 5 such lines in the log were
 *    followed by the recovery WARN, and each was counted twice by the error tracker.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { BrowserServer, getBrowserServerAuthSecret } from '../../../src/infrastructure/browser/browser-server.ts';
import { logger } from '../../../src/logger.ts';

function post(port: number, path: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'X-Browser-Auth': getBrowserServerAuthSecret(), 'Content-Type': 'application/json' },
      },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve()); res.on('error', () => resolve()); },
    );
    req.on('error', () => resolve());
    req.end(JSON.stringify(body));
  });
}

describe('BrowserServer — per-URL scrape outcomes are not server faults', () => {
  let server: BrowserServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; vi.restoreAllMocks(); });

  const benign: Array<[string, string]> = [
    ['a remote HTTP error', 'HTTP 404'],
    ['a navigation timeout', 'Scrape task timed out after 15000ms'],
    ['an over-cap PDF', 'PDF too large (412MB, max 100MB)'],
  ];

  for (const [label, message] of benign) {
    it(`logs ${label} at debug rather than ERROR`, async () => {
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      server = new BrowserServer({
        onSearch: async () => [],
        onScrape: async () => { throw new Error(message); },
        onHealthCheck: async () => ({ success: true }),
      } as any);
      const port = await server.start();
      await post(port, '/scrape', { url: 'https://example.com/x' });

      const handlerErrors = errorSpy.mock.calls.filter(c => String(c[0]).includes('Error handling request'));
      expect(handlerErrors).toHaveLength(0);
      expect(debugSpy.mock.calls.some(c => String(c[0]).includes('Expected per-URL scrape outcome'))).toBe(true);
    });
  }

  it('keeps a bot-protection interstitial on its existing WARN branch', async () => {
    // Cloudflare is matched by the earlier isCloudflareBlockError branch, which
    // already reported it at WARN. The new benign branch must not swallow it into
    // debug — a blocked domain is worth a visible line.
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    server = new BrowserServer({
      onSearch: async () => [],
      onScrape: async () => { throw new Error('Fetch blocked: Cloudflare challenge unresolved'); },
      onHealthCheck: async () => ({ success: true }),
    } as any);
    const port = await server.start();
    await post(port, '/scrape', { url: 'https://example.com/x' });

    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('Error handling request'))).toHaveLength(0);
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('blocked by bot protection'))).toBe(true);
  });

  it('still logs a genuine handler fault at ERROR', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    server = new BrowserServer({
      onSearch: async () => [],
      onScrape: async () => { throw new Error('Cannot read properties of undefined (reading Symbol.iterator)'); },
      onHealthCheck: async () => ({ success: true }),
    } as any);
    const port = await server.start();
    await post(port, '/scrape', { url: 'https://example.com/x' });

    expect(errorSpy.mock.calls.some(c => String(c[0]).includes('Error handling request'))).toBe(true);
  });
});

describe('BrowserClient — a retryable socket failure is not a terminal error', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('logs a leader-handover ECONNREFUSED at debug and does not track it', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const { errorTracker } = await import('../../../src/utils/error-tracker.ts');
    const trackSpy = vi.spyOn(errorTracker, 'trackError').mockImplementation(() => {});
    const { BrowserClient } = await import('../../../src/infrastructure/browser/browser-client.ts');

    // Port 1 is never listening, so the request fails with ECONNREFUSED — the exact
    // shape a follower sees against a leader that has already exited.
    const client = new BrowserClient(1);
    await expect(client.runScrape('https://example.com/', undefined)).rejects.toThrow(/unreachable|ECONNREFUSED/);

    const clientErrors = errorSpy.mock.calls.filter(c => String(c[0]).includes('[BrowserClient] Request to'));
    expect(clientErrors).toHaveLength(0);
    expect(debugSpy.mock.calls.some(c => String(c[0]).includes('caller will retry'))).toBe(true);
    // The caller records this with richer context on its retry path; tracking here too
    // double-counted every recovered handover in the diagnostic error report.
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
