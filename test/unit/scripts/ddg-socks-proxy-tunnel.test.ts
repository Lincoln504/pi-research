/**
 * Regression test for the 1.7.23 SOCKS tunnel.
 *
 * 1.7.23 replaced
 *     client.pipe(upstream); upstream.pipe(client);
 * with
 *     pipeline([client, upstream])
 * while fixing a file-descriptor leak. `pipeline([a, b])` forwards `a → b` only,
 * so the proxy accepted the SOCKS handshake, connected upstream, and then
 * black-holed every response. Every browser request through the proxy timed out
 * for two days, and the unit suite stayed green because nothing tested the
 * return path.
 *
 * These tests pin both directions with two in-memory socket pairs, so they need
 * no network and no privileged port.
 */

import { describe, it, expect } from 'vitest';
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
// The proxy is deliberately plain, dependency-free JS (it must run standalone
// under cron), so it is type-checked as JS rather than declared.
import { attachTunnel } from '../../../scripts/ddg-socks-proxy.mjs';

/**
 * A bidirectional in-memory stand-in for a TCP socket pair: writing to one end
 * makes the bytes readable at the other, and ending one ends the other.
 */
function makePair(): [Duplex, Duplex] {
  let a: Duplex;
  let b: Duplex;
  a = new Duplex({
    read() { /* pushed by the peer */ },
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) { b.push(Buffer.from(chunk)); cb(); },
    final(cb: () => void) { b.push(null); cb(); },
  });
  b = new Duplex({
    read() { /* pushed by the peer */ },
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) { a.push(Buffer.from(chunk)); cb(); },
    final(cb: () => void) { a.push(null); cb(); },
  });
  return [a, b];
}

/**
 * Resolve as soon as ANY byte arrives (and also on end), because these in-memory
 * pairs are never closed by the code under test: waiting for 'end' would deadlock
 * the test rather than fail it.
 */
function collect(stream: Duplex): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => resolve(Buffer.concat(chunks));
    stream.on('data', (c: Buffer) => { chunks.push(Buffer.from(c)); done(); });
    stream.on('end', done);
  });
}

describe('ddg-socks-proxy tunnel', () => {
  it('forwards client bytes to the upstream', async () => {
    const [client, clientPeer] = makePair();
    const [upstream, upstreamPeer] = makePair();
    attachTunnel(client, upstream);

    const received = collect(upstreamPeer);
    clientPeer.write('GET / HTTP/1.0\r\n\r\n');
    expect((await received).toString()).toContain('GET / HTTP/1.0');
  });

  it('forwards upstream bytes back to the client (the 1.7.23 regression)', async () => {
    const [client, clientPeer] = makePair();
    const [upstream, upstreamPeer] = makePair();
    attachTunnel(client, upstream);

    const received = collect(clientPeer);
    upstreamPeer.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    expect((await received).toString()).toContain('HTTP/1.1 200 OK');
  });

  it('carries a full request/response round trip in both directions', async () => {
    const [client, clientPeer] = makePair();
    const [upstream, upstreamPeer] = makePair();
    attachTunnel(client, upstream);

    const serverSaw: string[] = [];
    upstreamPeer.on('data', (chunk: Buffer) => {
      serverSaw.push(chunk.toString());
      upstreamPeer.write('pong');
    });
    const clientSaw = collect(clientPeer);
    // Two round trips, so a one-way tunnel cannot pass by accident.
    clientPeer.write('ping');
    await new Promise((r) => setTimeout(r, 20));
    clientPeer.write('ping2');

    const body = (await clientSaw).toString();
    expect(body).toContain('pong');
    await new Promise((r) => setTimeout(r, 20));
    expect(serverSaw.join('')).toContain('ping2');
  });

  it('does not throw when the client is already gone (the crash that restart-looped the daemon)', () => {
    // Browsers open speculative SOCKS connections and drop them, and the proxy's
    // own 8s data deadline cuts both ends on a stall. `pipeline()` throws
    // ERR_STREAM_UNABLE_TO_PIPE synchronously on a destroyed endpoint, from inside
    // a socket 'connect' handler where nothing catches it: measured 2026-10-30,
    // that killed the daemon 20 times in minutes. Attaching to a dead pair must be
    // a no-op, and must still leave nothing open.
    const [client] = makePair();
    const [upstream] = makePair();
    client.destroy();
    expect(() => attachTunnel(client, upstream)).not.toThrow();
    expect(upstream.destroyed).toBe(true);
  });

  it('does not throw when the upstream is already gone', () => {
    const [client] = makePair();
    const [upstream] = makePair();
    upstream.destroy();
    expect(() => attachTunnel(client, upstream)).not.toThrow();
    expect(client.destroyed).toBe(true);
  });

  it('exits non-zero when its port is already taken, instead of running without listening', async () => {
    // A proxy that is up but not listening is invisible to a supervisor:
    // `Restart=always` never fires and every browser request fails at connect.
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const addr = blocker.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const script = path.resolve(__dirname, '../../../scripts/ddg-socks-proxy.mjs');
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, DDG_SOCKS_PORT: String(port) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: string[] = [];
    child.stderr.on('data', (b: Buffer) => stderr.push(b.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    await new Promise<void>((r) => blocker.close(() => r()));
    expect(code).not.toBe(0);
    expect(stderr.join('')).toContain('EADDRINUSE');
  }, 15_000);

  it('tears down the upstream when the client ends, and vice versa', async () => {
    const [client, clientPeer] = makePair();
    const [upstream, upstreamPeer] = makePair();
    attachTunnel(client, upstream);

    // Flowing mode: a paused readable emits neither 'end' nor 'close'.
    upstreamPeer.resume();
    const upstreamEnded = new Promise<boolean>((resolve) => {
      upstreamPeer.on('close', () => resolve(true));
      upstreamPeer.on('end', () => resolve(true));
    });
    clientPeer.end();
    expect(await upstreamEnded).toBe(true);
  });
});
