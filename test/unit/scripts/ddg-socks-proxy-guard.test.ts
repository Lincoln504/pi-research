/**
 * Wire-level test for the SOCKS5 destination guard in scripts/ddg-socks-proxy.mjs.
 *
 * The unit tests cover the classifier; this covers that the classifier is actually ON the
 * SOCKS request path and that a refusal is a SOCKS "connection not allowed by ruleset"
 * reply (0x02), which is what Firefox and the browser see.
 *
 * No external egress: both cases are refused before any connect attempt. A positive
 * handshake would need a public destination (real network), so the "hostname passes the
 * name stage" property is pinned at the classifier level instead
 * (test/unit/scripts/private-addresses.test.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/ddg-socks-proxy.mjs');

let child: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function startProxy(): Promise<number> {
  const port = await freePort();
  child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, DDG_SOCKS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = child!;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start within 5s')), 5000);
    proc.stdout!.on('data', (buf: Buffer) => {
      if (buf.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // A child that dies (EADDRINUSE, a bad import) must surface as its own failure, not
    // as "did not start within 5s".
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited before listening (code ${code})`));
    });
  });
  return port;
}

/** Speak SOCKS5 no-auth and one CONNECT; resolve the reply's second byte (0x00 = ok). */
async function socksConnect(port: number, atyp: 1 | 3, host: string, targetPort = 80): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: one method, no-auth
    });
    let stage: 'greet' | 'reply' = 'greet';
    sock.on('data', (chunk) => {
      if (stage === 'greet') {
        // Reject rather than expect() inside a socket handler: an assertion thrown here
        // would surface as the 5s timeout, hiding the real diagnostic.
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) {
          sock.destroy();
          reject(new Error(`unexpected SOCKS greeting: [${[...chunk]}]`));
          return;
        }
        let request: Buffer;
        if (atyp === 1) {
          const parts = host.split('.').map(Number);
          request = Buffer.from([0x05, 0x01, 0x00, 0x01, ...parts, (targetPort >> 8) & 0xff, targetPort & 0xff]);
        } else {
          const name = Buffer.from(host, 'utf8');
          request = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
            name,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]);
        }
        stage = 'reply';
        sock.write(request);
        return;
      }
      sock.destroy();
      resolve(typeof chunk[1] === 'number' ? chunk[1] : -1);
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error('SOCKS reply timeout'));
    });
  });
}

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

describe('ddg-socks-proxy destination guard (wire level)', () => {
  it('refuses an IPv4 CONNECT into loopback with 0x02, never dialling it', async () => {
    const port = await startProxy();
    // A listener on 127.0.0.1 that must NOT be reached: its existence is what makes the
    // test meaningful (before the guard, this CONNECT would have succeeded).
    const target = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const targetPort = (target.address() as net.AddressInfo).port;
    let reached = false;
    target.on('connection', () => { reached = true; });

    const reply = await socksConnect(port, 1, '127.0.0.1', targetPort);

    expect(reply).toBe(0x02); // "connection not allowed by ruleset"
    expect(reached).toBe(false);
    await new Promise<void>((r) => target.close(() => r()));
  });

  it('refuses a domain CONNECT to localhost by name, without DNS', async () => {
    const port = await startProxy();
    const reply = await socksConnect(port, 3, 'localhost', 8080);
    expect(reply).toBe(0x02);
  });
});
