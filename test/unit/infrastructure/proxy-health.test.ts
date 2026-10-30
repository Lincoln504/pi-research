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
  /** Write bytes after the success reply ("" reproduces the black-hole). */
  readonly respond?: string | null;
}

/** A minimal SOCKS5 server that answers the greeting and one CONNECT. */
function startFakeSocks(options: FakeOptions = {}): Promise<{ port: number }> {
  const connectReply = options.connectReply ?? 0x00;
  const respond = options.respond === undefined ? 'HTTP/1.0 200 OK\r\n\r\n' : options.respond;
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      let stage: 'greet' | 'request' | 'done' = 'greet';
      sock.on('error', () => sock.destroy());
      sock.on('data', (chunk: Buffer) => {
        if (stage === 'greet') {
          if (chunk.length < 2) return;
          sock.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
          return;
        }
        if (stage === 'request') {
          sock.write(Buffer.from([0x05, connectReply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 'done';
          if (connectReply === 0x00 && respond !== null) sock.write(respond);
        }
      });
    });
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve({ port: addr.port });
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

describe('describeProxyIfBroken', () => {
  it('is silent when no proxy is configured', async () => {
    expect(await describeProxyIfBroken()).toBeNull();
  });

  it('names the broken proxy, so a search failure can say what is wrong', async () => {
    const { port } = await startFakeSocks({ respond: null });
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-proxy-'));
    dirs.push(dir);
    const file = path.join(dir, 'proxy.json');
    writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port }));
    process.env['PI_RESEARCH_PROXY_JSON'] = file;
    resetSocksProxyCache();

    const message = await describeProxyIfBroken();
    expect(message).toContain('SOCKS proxy check');
    expect(message).toContain('returned no data');
  });

  it('is silent when the proxy forwards traffic', async () => {
    const { port } = await startFakeSocks();
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-proxy-'));
    dirs.push(dir);
    const file = path.join(dir, 'proxy.json');
    writeFileSync(file, JSON.stringify({ host: '127.0.0.1', port }));
    process.env['PI_RESEARCH_PROXY_JSON'] = file;
    resetSocksProxyCache();

    expect(await describeProxyIfBroken()).toBeNull();
  });
});
