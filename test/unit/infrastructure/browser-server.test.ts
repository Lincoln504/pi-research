/**
 * BrowserServer Unit Tests
 *
 * Verifies the headers-sent guard in the request handler's catch block: when a
 * response fails AFTER writeHead(200) (e.g. the result payload cannot be
 * serialized), the handler must destroy the response instead of calling
 * writeHead(500) — which would throw ERR_HTTP_HEADERS_SENT inside the async
 * 'end' listener and surface as an unhandledRejection in the leader process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { BrowserServer, getBrowserServerAuthSecret } from '../../../src/infrastructure/browser/browser-server.ts';

interface PostOutcome {
  status?: number;
  data?: string;
  failed: boolean;
}

function post(port: number, path: string, body: unknown): Promise<PostOutcome> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'X-Browser-Auth': getBrowserServerAuthSecret(),
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, data, failed: false }));
        res.on('aborted', () => resolve({ status: res.statusCode, failed: true }));
        res.on('error', () => resolve({ status: res.statusCode, failed: true }));
      },
    );
    req.on('error', () => resolve({ failed: true }));
    req.end(JSON.stringify(body));
  });
}

describe('BrowserServer — headers-sent guard in the catch path', () => {
  let server: BrowserServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('destroys the socket instead of writeHead(500) when serialization fails after the 200 header, and the server survives', async () => {
    // JSON.stringify(BigInt) throws — but only AFTER res.writeHead(200) has
    // already been called, which is exactly the partially-sent-response case.
    server = new BrowserServer({
      onSearch: async () => ([{ big: 1n }] as any),
      onScrape: async () => ({}),
      onHealthCheck: async () => ({ success: true }),
    });
    const port = await server.start();

    // Capture unhandledRejections: pre-fix, the second writeHead threw
    // ERR_HTTP_HEADERS_SENT inside the async 'end' listener.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);

    try {
      const outcome = await post(port, '/search', { query: 'q' });
      // The response is aborted mid-flight (socket destroyed) — never a clean
      // 500-after-200 or a completed body.
      expect(outcome.failed).toBe(true);

      // The leader process/server must survive: a subsequent request works.
      const health = await post(port, '/healthcheck', {});
      expect(health.status).toBe(200);
      expect(JSON.parse(health.data ?? '')).toEqual({ success: true });

      // Give any pending rejection a tick to surface, then assert none did.
      await new Promise((r) => setTimeout(r, 25));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
  });

  it('still returns a clean 500 when the handler fails before any header is sent', async () => {
    server = new BrowserServer({
      onSearch: async () => { throw new Error('boom\nsecret stack line'); },
      onScrape: async () => ({}),
      onHealthCheck: async () => ({ success: true }),
    });
    const port = await server.start();

    const outcome = await post(port, '/search', { query: 'q' });
    expect(outcome.failed).toBe(false);
    expect(outcome.status).toBe(500);
    expect(JSON.parse(outcome.data ?? '')).toEqual({ error: 'boom' });
  });
});
