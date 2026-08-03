/**
 * BrowserServer drain + connection-tracking tests.
 *
 * When a leader loses the election it tears down its pool. Before this drain
 * existed, a connected client kept issuing requests into that teardown and only
 * discovered the leader was gone via a connect timeout or a bare
 * ECONNREFUSED/RST once the listener closed — a silent stall ahead of every
 * re-election. `beginDrain()` converts that into an immediate 503 the client can
 * act on.
 *
 * These exercise a real HTTP server over loopback (no mocking of the transport),
 * because the properties that matter — status codes, header ordering relative to
 * auth, and whether an in-flight request survives — only exist at that layer.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { BrowserServer, getBrowserServerAuthSecret } from '../../../src/infrastructure/browser/browser-server.ts';
import { BrowserClient } from '../../../src/infrastructure/browser/browser-client.ts';
import {
  isServerDrainingError,
  isTransientSocketError,
  getBrowserCircuitBreaker,
  resetBrowserCircuitBreaker,
} from '../../../src/infrastructure/browser/browser-error-utils.ts';

interface PostOutcome {
  status?: number;
  data: string;
  headers: http.IncomingHttpHeaders;
  failed: boolean;
}

function post(
  port: number,
  path: string,
  body: unknown,
  opts: { auth?: string; agent?: http.Agent } = {},
): Promise<PostOutcome> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: opts.agent,
        headers: {
          'X-Browser-Auth': opts.auth ?? getBrowserServerAuthSecret(),
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers, failed: false }));
        res.on('error', () => resolve({ status: res.statusCode, data, headers: res.headers, failed: true }));
      },
    );
    req.on('error', () => resolve({ status: undefined, data: '', headers: {}, failed: true }));
    req.end(JSON.stringify(body));
  });
}

/** Poll a predicate until true, so socket-close bookkeeping isn't raced. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: BrowserServer | null = null;

function makeServer(overrides: Partial<{ onSearch: (q: string) => Promise<any>; onScrape: (u: string) => Promise<any>; onHealthCheck: () => Promise<{ success: boolean }> }> = {}): BrowserServer {
  return new BrowserServer({
    onSearch: overrides.onSearch ?? (async () => [{ title: 'ok', url: 'https://example.test', snippet: '' } as any]),
    onScrape: overrides.onScrape ?? (async () => ({ markdown: 'ok' })),
    onHealthCheck: overrides.onHealthCheck ?? (async () => ({ success: true })),
  });
}

afterEach(async () => {
  await server?.stop();
  server = null;
  resetBrowserCircuitBreaker();
});

describe('BrowserServer — drain', () => {
  it('serves normally before drain and 503s afterwards', async () => {
    server = makeServer();
    const port = await server.start();

    const before = await post(port, '/search', { query: 'x' });
    expect(before.status).toBe(200);
    expect(server.isDraining()).toBe(false);

    server.beginDrain('leadership-lost');
    expect(server.isDraining()).toBe(true);

    const after = await post(port, '/search', { query: 'x' });
    expect(after.status).toBe(503);
    expect(JSON.parse(after.data)).toEqual({ error: 'draining', reason: 'leadership-lost' });
    // Tells the client not to reuse this socket for a retry that can only 503 again.
    expect(String(after.headers['connection'])).toBe('close');
  });

  it('applies drain to every route, including healthcheck', async () => {
    server = makeServer();
    const port = await server.start();
    server.beginDrain();

    // Healthcheck must 503 too: a client that still saw a healthy leader here
    // would keep the dead leader selected and never re-elect.
    for (const path of ['/search', '/scrape', '/healthcheck']) {
      const res = await post(port, path, {});
      expect(res.status, `${path} should drain`).toBe(503);
    }
  });

  it('rejects unauthenticated callers with 403, not 503, while draining', async () => {
    server = makeServer();
    const port = await server.start();
    server.beginDrain();

    // Drain state is leadership information; an unauthenticated local process
    // must not be able to probe it. Auth is therefore checked first.
    const res = await post(port, '/search', { query: 'x' }, { auth: 'wrong-secret' });
    expect(res.status).toBe(403);
  });

  it('lets an in-flight request finish rather than truncating it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started = false;

    server = makeServer({
      onSearch: async () => {
        started = true;
        await gate;
        return [{ title: 'finished', url: 'https://example.test', snippet: '' } as any];
      },
    });
    const port = await server.start();

    const inflight = post(port, '/search', { query: 'slow' });
    await until(() => started);

    // Drain begins while the request is already past the check.
    server.beginDrain();
    release();

    const res = await inflight;
    expect(res.status).toBe(200);
    expect(res.data).toContain('finished');
  });

  it('is idempotent, and the first reason wins', async () => {
    server = makeServer();
    const port = await server.start();

    server.beginDrain('leadership-lost');
    server.beginDrain('idle-timeout');
    server.beginDrain();
    expect(server.isDraining()).toBe(true);
    const res = await post(port, '/search', { query: 'x' });
    expect(res.status).toBe(503);
    // The reason that actually caused teardown must not be overwritten by a later
    // redundant call, or the incident is misattributed in the client's log.
    expect(JSON.parse(res.data).reason).toBe('leadership-lost');
  });

  it('reports the caller-supplied reason, defaulting to a neutral one', async () => {
    server = makeServer();
    const port = await server.start();
    // Every teardown reaches this path — a lost election, an idle timeout, a normal
    // process exit. Hardcoding "leadership-lost" would misreport the other two.
    server.beginDrain('idle-timeout');
    expect(JSON.parse((await post(port, '/search', {})).data).reason).toBe('idle-timeout');

    await server.stop();
    server = makeServer();
    const port2 = await server.start();
    server.beginDrain();
    expect(JSON.parse((await post(port2, '/search', {})).data).reason).toBe('shutting-down');
  });
});

describe('BrowserServer — connection tracking', () => {
  it('counts attached client sockets and releases them on close', async () => {
    server = makeServer();
    const port = await server.start();

    expect(server.hasActiveClients()).toBe(false);
    expect(server.getConnectionCount()).toBe(0);

    // keepAlive holds the socket open past the response so the count is
    // observable rather than a race against immediate teardown.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const res = await post(port, '/search', { query: 'x' }, { agent });
    expect(res.status).toBe(200);

    await until(() => server!.getConnectionCount() >= 1);
    expect(server.hasActiveClients()).toBe(true);

    agent.destroy();
    await until(() => server!.getConnectionCount() === 0);
    expect(server.hasActiveClients()).toBe(false);
  });

  it('clears tracked connections on stop', async () => {
    server = makeServer();
    const port = await server.start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await post(port, '/search', { query: 'x' }, { agent });
    await until(() => server!.getConnectionCount() >= 1);

    await server.stop();
    expect(server.getConnectionCount()).toBe(0);
    expect(server.hasActiveClients()).toBe(false);

    agent.destroy();
    server = null; // already stopped
  });
});

describe('BrowserClient against a draining BrowserServer', () => {
  it('surfaces a classifiable drain error rather than a generic HTTP failure', async () => {
    server = makeServer();
    const port = await server.start();
    const client = new BrowserClient(port, getBrowserServerAuthSecret());

    // Healthy leader first, so the failure below is attributable to drain alone.
    await expect(client.runSearch('anything')).resolves.toBeDefined();

    server.beginDrain('leadership-lost');

    // The real client must turn the 503 into the drain-classified error. If it
    // fell through to the generic `HTTP 503` branch, isServerDrainingError would
    // miss it, the breaker would count the handover as an infrastructure failure,
    // and retry paths would not treat it as transient.
    const err = await client.runSearch('anything').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isServerDrainingError(err)).toBe(true);
    expect(isTransientSocketError(err)).toBe(true);
    expect((err as Error).message).toContain('leadership-lost');
  });
});

describe('drain error classification', () => {
  const drainError = new Error('Browser pool leader is draining (leadership-lost) — re-elect and retry');

  it('recognises the drain rejection', () => {
    expect(isServerDrainingError(drainError)).toBe(true);
    expect(isServerDrainingError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isServerDrainingError(null)).toBe(false);
    expect(isServerDrainingError('a string')).toBe(false);
  });

  it('treats drain as transient so the caller retries into the new leader', () => {
    expect(isTransientSocketError(drainError)).toBe(true);
  });

  it('does not let a leadership handover open the circuit breaker', async () => {
    const breaker = getBrowserCircuitBreaker('drain-session');
    // Far past the failureThreshold of 8: if drain counted as a failure the
    // breaker would be open and reject the next call outright.
    for (let i = 0; i < 20; i++) {
      await expect(
        breaker.execute(async () => {
          throw drainError;
        }),
      ).rejects.toThrow(/draining/);
    }

    await expect(breaker.execute(async () => 'served')).resolves.toBe('served');
  });
});
