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

      // Give any pending rejection a chance to surface, then assert none did.
      // Node fires 'unhandledRejection' on the next microtask-queue drain after a
      // promise is left unhandled, but a fixed short wait fails OPEN on a slow/
      // contended CI runner: the listener is removed in `finally` right after this
      // check, so a rejection that surfaces even slightly late is silently missed
      // rather than failing the test. Flush several real event-loop turns
      // (setImmediate runs after I/O callbacks, unlike a bare microtask) before
      // the final timeout backstop, so this holds under load rather than merely
      // under this suite's current speed.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
      await new Promise((r) => setTimeout(r, 100));
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

describe('BrowserServer — follower cancellation crosses the HTTP hop', () => {
  let server: BrowserServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('aborts the leader-side task when the client socket closes before completion', async () => {
    // Pre-fix the routes carried only query/url: when a follower aborted, its
    // socket died but the leader-side task kept its queue slot (and worker
    // page) until its full timeout. The per-request signal must abort the
    // moment the connection tears down.
    let receivedSignal: AbortSignal | undefined;
    let searchStarted!: () => void;
    const started = new Promise<void>((r) => { searchStarted = r; });
    server = new BrowserServer({
      onSearch: (_q: string, signal?: AbortSignal) => {
        receivedSignal = signal;
        searchStarted();
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      onScrape: async () => ({}),
      onHealthCheck: async () => ({ success: true }),
    });
    const port = await server.start();

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/search',
      method: 'POST',
      headers: {
        'X-Browser-Auth': getBrowserServerAuthSecret(),
        'Content-Type': 'application/json',
      },
    });
    req.on('error', () => { /* expected on destroy */ });
    req.end(JSON.stringify({ query: 'q' }));

    await started;
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    // The follower gives up mid-flight.
    req.destroy();

    const deadline = Date.now() + 2000;
    while (!receivedSignal!.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(receivedSignal!.aborted).toBe(true);
  });

  it('does NOT abort a request that completes normally', async () => {
    let receivedSignal: AbortSignal | undefined;
    server = new BrowserServer({
      onSearch: async (_q: string, signal?: AbortSignal) => {
        receivedSignal = signal;
        return [];
      },
      onScrape: async () => ({}),
      onHealthCheck: async () => ({ success: true }),
    });
    const port = await server.start();

    const outcome = await post(port, '/search', { query: 'q' });
    expect(outcome.status).toBe(200);
    // 'close' fires after a completed response too — it must not abort.
    await new Promise((r) => setTimeout(r, 25));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
  });

  // Regression: onHealthCheck did not receive the per-request signal at all —
  // its BrowserServerOptions type had no signal parameter, and the /healthcheck
  // case called `this.options.onHealthCheck()` with no argument, unlike the
  // /search and /scrape cases a few lines above. Masked in production because
  // the one caller (src/healthcheck/index.ts) never passes a signal — but the
  // interface gap means any future caller that does pass one is silently
  // ignored, with no compiler error to catch it.
  it('aborts the leader-side healthcheck task when the client socket closes before completion', async () => {
    let receivedSignal: AbortSignal | undefined;
    let healthcheckStarted!: () => void;
    const started = new Promise<void>((r) => { healthcheckStarted = r; });
    server = new BrowserServer({
      onSearch: async () => ([]),
      onScrape: async () => ({}),
      onHealthCheck: (signal?: AbortSignal) => {
        receivedSignal = signal;
        healthcheckStarted();
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve({ success: false }), { once: true });
        });
      },
    });
    const port = await server.start();

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/healthcheck',
      method: 'POST',
      headers: {
        'X-Browser-Auth': getBrowserServerAuthSecret(),
        'Content-Type': 'application/json',
      },
    });
    req.on('error', () => { /* expected on destroy */ });
    req.end(JSON.stringify({}));

    await started;
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    // The follower gives up mid-flight.
    req.destroy();

    const deadline = Date.now() + 2000;
    while (!receivedSignal!.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(receivedSignal!.aborted).toBe(true);
  });
});
