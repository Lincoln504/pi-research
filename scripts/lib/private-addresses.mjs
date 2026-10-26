import net from 'node:net';

/**
 * Destination guard for `scripts/ddg-socks-proxy.mjs`.
 *
 * Why this exists at all: the browser's SSRF backstop (`serverAddr()` in
 * src/infrastructure/browser/thread-worker-messaging.ts) compares the address Firefox
 * actually connected to against the resolved address, to catch DNS rebinding. Through a
 * SOCKS5 proxy that comparison is impossible — Firefox never sees the origin address and
 * reports `0.0.0.0` — so the backstop is skipped for proxied use (see
 * src/infrastructure/browser/proxy-prefs.ts). The proxy sits on the socket, resolves every
 * destination itself, and is therefore the only place left that can refuse to connect to
 * internal infrastructure.
 *
 * Deliberately dependency-free and separate from the TS source: the proxy runs standalone
 * under cron (`node scripts/ddg-socks-proxy.mjs`) and cannot import the TypeScript tree.
 * The ranges mirror the TS classifier (`isPrivateIp` / `isPrivateIpv6` in
 * src/web-research/scraper-utils.ts) plus this guard's baseline; keep the two in step.
 */

/** IPv4 ranges that must never be a scrape destination. */
function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    // Not a dotted quad: not something this guard can vouch for. Fail closed —
    // resolve() only ever yields dotted quads, so this means a malformed input.
    return true;
  }
  const [a, b, c] = parts;
  return (
    a === 0 ||                                   // 0.0.0.0/8 "this network"
    a === 10 ||                                  // RFC 1918
    (a === 100 && b >= 64 && b <= 127) ||        // RFC 6598 CGNAT / cloud-internal
    a === 127 ||                                 // loopback
    (a === 169 && b === 254) ||                  // link-local, incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) ||         // RFC 1918
    (a === 192 && b === 168) ||                  // RFC 1918
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol / TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) ||     // RFC 2544 benchmarking
    (a === 198 && b === 51 && c === 100) ||      // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||       // TEST-NET-3
    a >= 224                                     // multicast + reserved + broadcast
  );
}

/** Expand an IPv6 literal to 8 hextets, or null when it is not parseable. */
function ipv6Hextets(address) {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '');
  // Drop a zone id (fe80::1%eth0).
  const pct = text.indexOf('%');
  if (pct !== -1) text = text.slice(0, pct);

  // An embedded dotted quad in the tail (::ffff:127.0.0.1) becomes two hextets.
  const dotted = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(text);
  if (dotted) {
    const quad = dotted[2].split('.').map(Number);
    if (quad.length !== 4 || quad.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    text = `${dotted[1]}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = halves.length === 2
    ? [...head, ...Array(missing).fill('0'), ...tail]
    : head;
  const hextets = all.map((h) => parseInt(h, 16));
  if (hextets.some((h) => !Number.isInteger(h) || h < 0 || h > 0xffff)) return null;
  return hextets;
}

function isBlockedIpv6(address) {
  const hextets = ipv6Hextets(address);
  if (!hextets) return true; // unparseable → refuse
  const [h0, h1, , , , h5, h6, h7] = hextets;

  // :: and ::1
  if (hextets.every((h) => h === 0)) return true;
  if (hextets.slice(0, 7).every((h) => h === 0) && h7 === 1) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded v4 address.
  if (hextets.slice(0, 5).every((h) => h === 0) && (h5 === 0xffff || h5 === 0)) {
    const v4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    return isBlockedIpv4(v4);
  }
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast, and the
  // deprecated site-local fec0::/10 (RFC 3879) — private/reserved space with
  // no legitimate scrape target. Range checks mirror the TS classifier's
  // string-prefix checks exactly (fc/fd, fe8–feb plus fec–fef, ff).
  // fec0::/10 is a subset of fe80::/10, so the /10 range covers it.
  if (h0 >= 0xfc00 && h0 <= 0xfdff) return true;
  if (h0 >= 0xfe80 && h0 <= 0xfeff) return true;
  if (h0 >= 0xff00) return true;
  // 6to4 (2002::/16), Teredo (2001::/32) and NAT64 (64:ff9b::/96) tunnel an
  // IPv4 address inside the IPv6 literal, so a public-looking literal can
  // carry a private/loopback IPv4 (2002:7f00:1:: → 127.0.0.x,
  // 64:ff9b::a9fe:a9fe → 169.254.169.254). Block the whole ranges, mirroring
  // the TS classifier (isPrivateIpv6 in src/web-research/scraper-utils.ts).
  if (h0 === 0x2002) return true;
  // Teredo is 2001:0::/32, NOT the whole 2001::/32: 2001:4860:4860::8888
  // (public DNS) must stay allowed, so the second hextet must be zero.
  if (h0 === 0x2001 && h1 === 0) return true;
  if (h0 === 0x0064 && h1 === 0xff9b) return true;
  return false;
}

/**
 * True when `address` is a loopback, private, link-local, CGNAT, multicast, reserved or
 * otherwise unparseable IP ADDRESS that the proxy must refuse to connect to.
 *
 * Takes an address, never a hostname. A hostname is not parseable as an address, so
 * passing one lands in the fail-closed branch and blocks it — see
 * `isBlockedProxyTarget`, which is what callers wanting to judge a host:port want.
 */
export function isBlockedDestination(address) {
  if (typeof address !== 'string' || address === '') return true;
  if (address.includes(':')) return isBlockedIpv6(address);
  return isBlockedIpv4(address);
}

/**
 * Decide a SOCKS request's destination before DNS: refuses names that resolve only to the
 * local host, refuses IP literals that point at internal space, and passes hostnames
 * through to be judged AFTER resolution (that second check is the load-bearing one, since
 * a name can resolve anywhere).
 *
 * Do not collapse this into `isBlockedDestination(host)`: every hostname is unparseable
 * as an address, so that call refuses everything. It did, on a live run: Firefox sends
 * `socks_remote_dns: true` domain-type requests for every hop, so a hostname-stage call
 * to the address guard refused all traffic, including the DuckDuckGo pins.
 */
export function isBlockedProxyTarget(host) {
  if (typeof host !== 'string' || host === '') return true;
  const name = host.toLowerCase().replace(/\.$/, '');
  // `localhost` and `*.localhost` are loopback by name and never reach DNS.
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  // An IP literal needs no resolution, so judge it now.
  if (net.isIP(name) !== 0) return isBlockedDestination(name);
  // A domain: judged by the addresses it resolves to (see the proxy's resolve() filter).
  return false;
}
