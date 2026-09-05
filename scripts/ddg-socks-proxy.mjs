#!/usr/bin/env node
/**
 * ddg-socks-proxy.mjs — minimal SOCKS5 (no-auth, CONNECT) local proxy.
 *
 * Why: egress for this machine (Tailscale exit node 67.173.236.18) can reach
 * only ONE of DuckDuckGo's two Azure front-doors. The system resolver hands
 * out the unreachable IP (52.250.42.157) for every duckduckgo.com hostname,
 * so every HTTP client (curl, Node fetch, Camoufox workers) times out at TCP
 * connect while the other front-door (40.89.244.232) answers in ~1s.
 *
 * This proxy CONNECTs on the caller's behalf and resolves *.duckduckgo.com to
 * the pinned, verified-live IP, using normal DNS for everything else. It is
 * deliberately dependency-free (net + dns only), holds no state beyond each
 * socket, and is safe to run under cron keepalive.
 *
 * Configuration:
 *   DDG_SOCKS_PORT    port to listen on (default 1080)
 *   DDG_PIN_IPS       comma-separated pinned IPs for duckduckgo.com (default
 *                     "52.250.42.157,40.89.244.232"). Which front-door is live
 *                     flips with the egress path, so the starting pin ROTATES
 *                     after every observed stall/failure and sticks to the
 *                     address that last delivered data.
 *
 * The worker-side hook is thread-worker-browser.ts: when
 * ~/.pi/research/proxy.json exists with {"port":N,"host":"127.0.0.1"}, the
 * browser is launched through this proxy (SOCKS remote DNS on).
 */

import net from 'node:net';
import dns from 'node:dns';

const PORT = Number(process.env.DDG_SOCKS_PORT || 1080);
const PINS = (process.env.DDG_PIN_IPS || '52.250.42.157,40.89.244.232').split(',').map((s) => s.trim()).filter(Boolean);

function isDdgHost(host) {
  return /(^|\.)duckduckgo\.com$/i.test(host);
}

function resolve(host) {
  if (isDdgHost(host)) {
    return Promise.resolve(PINS);
  }
  return new Promise((resolveP, rejectP) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return rejectP(err);
      resolveP(addrs.map((a) => a.address).filter(Boolean));
    });
  });
}

/**
 * Starting index into the pinned list for the next connection. Rotates past a
 * front-door the moment it shows the accept-then-stall pattern, and sticks to
 * the one that last delivered data — the live front-door flips with the
 * egress path, so no static order stays right for long.
 */
let pinIndex = 0;

// 8000ms data deadline ≈ half the 15s curl default: an all-dead edge costs
// ~16s of client time before failing, and the healthy front-door answers the
// TLS ClientHello in <1s.
const DATA_DEADLINE_MS = 8000;

/**
 * Try each pinned address (starting at the rotated pinIndex) until one
 * connects, then hand the socket over. The data deadline SPANS the TCP
 * connect and the post-connect TLS ClientHello wait — DDG's dead front-door
 * ACCEPTS the TCP handshake then never answers the ClientHello, so a deadline
 * cleared at connect (the old behavior) never caught it and clients hung
 * until their own 45s timeout.
 *
 * SOCKS has no transparent retry once the success reply is out (the client
 * speaks first over the tunnel and can't replay), so post-reply we can't
 * fail over: we cut both ends so the client fails fast, and rotate pinIndex
 * so the NEXT connection starts at the next front-door. The caller passes the
 * client socket precisely so it can be cut on that path.
 */
function connectWithFallback(client, addrs, port, cb) {
  let settled = false;
  let attempts = 0;
  const tryNext = () => {
    if (settled) return;
    if (attempts >= addrs.length) {
      settled = true;
      return cb(new Error('all pinned addresses failed'));
    }
    const offset = attempts++;
    const usedIdx = (pinIndex + offset) % addrs.length;
    const addr = addrs[usedIdx];
    const sock = net.connect({ host: addr, port });
    const deadline = setTimeout(() => {
      if (settled) {
        // Success reply already sent — no transparent retry is possible.
        // Fast-fail both ends and rotate the starting pin for next time.
        sock.destroy();
        client.destroy();
        pinIndex = (usedIdx + 1) % addrs.length;
        console.error(`[ddg-socks] ${addr} connected but sent no data within ${DATA_DEADLINE_MS}ms — client cut, rotating pin`);
        return;
      }
      sock.destroy();
      tryNext();
    }, DATA_DEADLINE_MS);
    sock.once('data', () => {
      clearTimeout(deadline);
      if (!settled) {
        settled = true;
        pinIndex = (usedIdx + 1) % addrs.length; // sticky: start AFTER the winner next time
        cb(null, sock);
      }
    });
    sock.once('connect', () => {
      // Do NOT clear the deadline here — the stall we must catch happens
      // after connect. Reply success immediately: the SOCKS client waits
      // for this reply before sending its first payload (TLS ClientHello),
      // and the upstream won't send anything until it receives one.
      if (!settled) {
        settled = true;
        cb(null, sock);
      }
    });
    sock.once('error', (err) => {
      clearTimeout(deadline);
      sock.destroy();
      if (!settled) tryNext();
    });
  };
  tryNext();
}

const server = net.createServer((client) => {
  client.on('error', () => client.destroy());
  let buf = Buffer.alloc(0);
  let stage = 'greet';
  let targetHost = '';
  let targetPort = 0;

  client.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    try {
      if (stage === 'greet') {
        if (buf.length < 2) return;
        const nmethods = buf[1];
        if (buf.length < 2 + nmethods) return;
        // Reply: no-auth required
        client.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(2 + nmethods);
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 4) return;
        const ver = buf[0];
        const cmd = buf[1];
        const atyp = buf[3];
        if (ver !== 5 || cmd !== 1) {
          client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // cmd not supported
          client.destroy();
          return;
        }
        if (atyp === 1) { // IPv4
          if (buf.length < 10) return;
          targetHost = [buf[4], buf[5], buf[6], buf[7]].join('.');
          targetPort = buf.readUInt16BE(8);
          buf = buf.subarray(10);
          stage = 'connect';
        } else if (atyp === 3) { // domain
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          targetHost = buf.subarray(5, 5 + len).toString('utf8');
          targetPort = buf.readUInt16BE(5 + len);
          buf = buf.subarray(7 + len);
          stage = 'connect';
        } else if (atyp === 4) { // IPv6
          if (buf.length < 22) return;
          const raw = buf.subarray(4, 20);
          const parts = [];
          for (let i2 = 0; i2 < 16; i2 += 2) parts.push(raw.readUInt16BE(i2).toString(16));
          targetHost = parts.join(':');
          targetPort = buf.readUInt16BE(20);
          buf = buf.subarray(22);
          stage = 'connect';
        } else {
          client.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // atyp not supported
          client.destroy();
          return;
        }
      }
      if (stage === 'connect') {
        stage = 'done';
        resolve(targetHost).then((addrs) => {
          connectWithFallback(client, addrs, targetPort, (err, upstream) => {
            if (err) {
              client.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); // host unreachable
              client.destroy();
              return;
            }
            // Success reply (IPv4 0.0.0.0:0 is acceptable)
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.on('error', () => upstream.destroy());
            client.pipe(upstream);
            upstream.pipe(client);
          });
        }).catch(() => {
          client.write(Buffer.from([0x05, 0x04, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.destroy();
        });
      }
    } catch {
      client.destroy();
    }
  });
});

server.on('error', (err) => {
  console.error(`[ddg-socks] server error: ${err.message}`);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ddg-socks] SOCKS5 listening on 127.0.0.1:${PORT} (pins: ${PINS.join(',')})`);
});