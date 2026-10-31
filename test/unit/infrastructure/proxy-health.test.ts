/**
 * The SOCKS proxy liveness probe.
 *
 * The probe exists because a proxy that ACCEPTS the handshake and then forwards
 * nothing is indistinguishable, from every other health check in the system,
 * from a healthy one. Each case below is a real failure mode from the logs:
 *   • 2026-10-28..30 — connects, replies success, returns zero bytes (one-way
 *     pipeline in 1.7.23). The probe's `no-data` case.
 *   • 2026-10-23 — the service is not running. `unreachable`.
 *   • the SSRF guard refusing a destination. `connect-rejected`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeSocksProxyForwarding, describeProxyIfBroken } from '../../../src/infrastructure/browser/proxy-health.ts';
import { resetSocksProxyCache } from '../../../src/infrastructure/browser/proxy-prefs.ts';

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  dirs.length = 0;
  delete process.env['PI_RESEARCH_PROXY_JSON'];
  resetSocksProxyCache();
});

interface FakeOptions {
  /** Reply code byte after the greeting (0x00 = success). */
  readonly connectReply?: number;
  /** Write bytes after the success reply (null reproduces the black-hole). */
  readonly respond?: string | null;
  /**
   * Per-target behaviour, keyed by the host in the SOCKS CONNECT request. Lets a
   * test make the proxy answer DuckDuckGo but not example.com (or the reverse)
   * without a network.
   */
  readonly respondForHost?: (host: string) => { reply?: number; data?: string | null } | undefined;
}

/**
 * A minimal SOCKS5 server: greeting, one CONNECT (the domain-type request this
 * probe sends), then whatever the case under test dictates.
 */
function startFakeSocks(options: FakeOptions = {}): Promise<{ port: number; connections: () => number }> {
  let connections = 0;
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      connections += 1;
      let stage: 'greet' | 'request' | 'done' = 'greet';
      let buffer = Buffer.alloc(0);
      sock.on('error', () => sock.destroy());
      sock.on('data', (chunk: Buffer) => {
        if (stage === 'done') return;
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === 'greet') {
          // Greeting is 3 bytes: VER, NMETHODS, METHODS[0].
          if (buffer.length < 3) return;
          sock.write(Buffer.from([0x05, 0x00]));
          buffer = buffer.subarray(3);
          stage = 'request';
        }
        if (stage === 'request') {
          // [5, cmd, 0, atyp=3, len, ...host, portHi, portLo]
          if (buffer.length < 5) return;
          const len = buffer[4] ?? 0;
          if (buffer.length < 5 + len + 2) return;
          const host = buffer.subarray(5, 5 + len).toString('utf8');
          const perHost = options.respondForHost?.(host);
          const reply = perHost?.reply ?? options.connectReply ?? 0x00;
          const data = perHost
            ? (perHost.data === undefined ? 'HTTP/1.0 200 OK\r\n\r\n' : perHost.data)
            : (options.respond === undefined ? 'HTTP/1.0 200 OK\r\n\r\n' : options.respond);
          sock.write(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'done';
          if (reply === 0x00 && data !== null) sock.write(data);
        }
      });
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve({ port: addr.port, connections: () => connections });
      else reject(new Error('no port'));
    });
  });
}

function endpoint(port: number) {
  return { host: '127.0.0.1', port };
}

describe('probeSocksProxyForwarding', () => {
  it('is healthy and reports not-configured when no proxy is set', async () => {
    const result = await probeSocksProxyForwarding(null);
    expect(result.healthy).toBe(true);
    expect(result.code).toBe('not-configured');
  });

  it('passes when the proxy returns bytes', async () => {
    const { port } = await startFakeSocks();
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 2000, dataTimeoutMs: 2000 });
    expect(result.healthy).toBe(true);
    expect(result.code).toBe('ok');
  });

  it('fails with no-data when the tunnel connects and returns nothing (the 1.7.23 bug)', async () => {
    const { port } = await startFakeSocks({ respond: null });
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 2000, dataTimeoutMs: 150 });
    expect(result.healthy).toBe(false);
    expect(result.code).toBe('no-data');
    expect(result.reason).toContain('returned no data');
  });

  it('fails with connect-rejected when the SSRF guard refuses the destination', async () => {
    const { port } = await startFakeSocks({ connectReply: 0x02 });
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 2000, dataTimeoutMs: 500 });
    expect(result.healthy).toBe(false);
    expect(result.code).toBe('connect-rejected');
    expect(result.reason).toContain('refused by ruleset');
  });

  it('fails with unreachable when nothing is listening', async () => {
    const { port } = await startFakeSocks();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 500 });
    expect(result.healthy).toBe(false);
    expect(result.code).toBe('unreachable');
  });

  it('fails with protocol-error when the greeting is not SOCKS5', async () => {
    const server = net.createServer((sock) => {
      sock.on('error', () => sock.destroy());
      sock.on('data', () => sock.write(Buffer.from([0x04, 0x05])));
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 2000 });
    expect(result.healthy).toBe(false);
    expect(result.code).toBe('protocol-error');
  });
});

function setProxyFile(port: number): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-proxy-'));
  dirs.push(dir);
  const file = path.join(dir, 'proxy.json');
  writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port }));
  process.env['PI_RESEARCH_PROXY_JSON'] = file;
  resetSocksProxyCache();
}

describe('probeSocksProxyForwarding abort handling', () => {
  it('returns code "aborted" instead of a verdict when the signal fires first', async () => {
    const { port } = await startFakeSocks({ respond: null });
    const controller = new AbortController();
    controller.abort();
    const result = await probeSocksProxyForwarding(endpoint(port), {
      timeoutMs: 2_000,
      dataTimeoutMs: 2_000,
      signal: controller.signal,
    });
    expect(result.code).toBe('aborted');
    expect(result.healthy).toBe(false);
  });

  it('aborts a probe that is waiting for data', async () => {
    const { port } = await startFakeSocks({ respond: null });
    const controller = new AbortController();
    const pending = probeSocksProxyForwarding(endpoint(port), {
      timeoutMs: 2_000,
      dataTimeoutMs: 5_000,
      signal: controller.signal,
    });
    // Let the handshake complete and the data timer arm, then cancel.
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    const result = await pending;
    expect(result.code).toBe('aborted');
  });

  it('targets DuckDuckGo by default so the proxy pins are exercised', async () => {
    let seenHost = '';
    const { port } = await startFakeSocks({
      respondForHost: (host) => { seenHost = host; return undefined; },
    });
    const result = await probeSocksProxyForwarding(endpoint(port), { timeoutMs: 2_000, dataTimeoutMs: 2_000 });
    expect(result.healthy).toBe(true);
    expect(seenHost).toBe('lite.duckduckgo.com');
  });
});

describe('describeProxyIfBroken', () => {
  it('is silent when no proxy is configured', async () => {
    expect(await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 })).toBeNull();
  });

  it('names the broken proxy, so a search failure can say what is wrong', async () => {
    const { port } = await startFakeSocks({ respond: null });
    setProxyFile(port);

    const message = await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 });
    expect(message).toContain('SOCKS proxy check');
    expect(message).toContain('returned no data');
    expect(message).toContain('tunnel itself is broken');
  });

  it('is silent when the proxy forwards traffic', async () => {
    const { port } = await startFakeSocks();
    setProxyFile(port);

    expect(await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 })).toBeNull();
  });

  it('does not convict the proxy on one bad sample: the second attempt decides', async () => {
    // First CONNECT is black-holed (a proxy restart mid-probe), every later one
    // answers. A single-sample verdict would abort a run that could proceed.
    let calls = 0;
    const { port } = await startFakeSocks({
      respondForHost: () => {
        calls += 1;
        return calls === 1 ? { data: null } : { data: 'HTTP/1.0 200 OK\r\n\r\n' };
      },
    });
    setProxyFile(port);

    expect(await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 })).toBeNull();
  });

  it('separates dead DuckDuckGo pins from a dead tunnel', async () => {
    // DDG black-holes, example.com answers. That is NOT a broken tunnel, and the
    // repair is repinning, not restarting the proxy.
    const { port } = await startFakeSocks({
      respondForHost: (host) => (host === 'example.com' ? { data: 'HTTP/1.0 200 OK\r\n\r\n' } : { data: null }),
    });
    setProxyFile(port);

    const message = await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 });
    expect(message).toContain('DuckDuckGo is unreachable through it');
    expect(message).toContain('Update DDG_PIN_IPS');
  });

  it('says the tunnel is broken when neither target forwards', async () => {
    const { port } = await startFakeSocks({ respond: null });
    setProxyFile(port);

    const message = await describeProxyIfBroken(undefined, { timeoutMs: 300, dataTimeoutMs: 300 });
    expect(message).toContain('did not forward traffic to example.com either');
  });

  it('returns null when the signal is already aborted (a cancelled run needs no verdict)', async () => {
    const { port } = await startFakeSocks({ respond: null });
    setProxyFile(port);
    const controller = new AbortController();
    controller.abort();
    expect(await describeProxyIfBroken(controller.signal)).toBeNull();
  });
});
