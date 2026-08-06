/**
 * Security regression tests for IPv6-literal SSRF bypasses.
 *
 * `new URL` keeps IPv6 literals bracketed ("[::1]") and normalizes IPv4-mapped
 * addresses to hex ("[::ffff:127.0.0.1]" → "[::ffff:7f00:1]"). The old guard
 * tested patterns against the bracketed string and only the resolved DNS
 * addresses, while dns.resolve6 REJECTS IP literals (EBADNAME) — so a literal
 * loopback/internal IPv6 slipped straight through. These cases must all be
 * blocked by the synchronous literal checks (no DNS, deterministic offline).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { validateUrlForSSRF } from '../../../src/web-research/scraper-utils.ts';

const FLAG = 'PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE';

describe('validateUrlForSSRF — IPv6 literal bypasses are blocked', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('blocks bare IPv6 loopback [::1]', async () => {
    await expect(validateUrlForSSRF('http://[::1]/')).rejects.toThrow();
  });

  it('blocks IPv4-mapped loopback in dotted form [::ffff:127.0.0.1]', async () => {
    await expect(validateUrlForSSRF('http://[::ffff:127.0.0.1]/')).rejects.toThrow();
  });

  it('blocks IPv4-mapped loopback in hex form [::ffff:7f00:1]', async () => {
    await expect(validateUrlForSSRF('http://[::ffff:7f00:1]/')).rejects.toThrow();
  });

  it('blocks the uncompressed mapped form [0:0:0:0:0:ffff:127.0.0.1]', async () => {
    await expect(validateUrlForSSRF('http://[0:0:0:0:0:ffff:127.0.0.1]/')).rejects.toThrow();
  });

  it('blocks mapped RFC1918 (10.x) and link-local cloud-metadata via IPv6 literal', async () => {
    await expect(validateUrlForSSRF('http://[::ffff:10.0.0.1]/')).rejects.toThrow();
    await expect(validateUrlForSSRF('http://[::ffff:169.254.169.254]/')).rejects.toThrow();
  });

  it('blocks unique-local fc00::/7 and link-local fe80::/10 literals', async () => {
    await expect(validateUrlForSSRF('http://[fc00::1]/')).rejects.toThrow();
    await expect(validateUrlForSSRF('http://[fe80::1]/')).rejects.toThrow();
  });

  it('blocks deprecated site-local fec0::/10 literals', async () => {
    // RFC 3879 deprecated site-local addressing in 2004, but it's still
    // squarely "private/reserved" space and sits right next to fe80::/10.
    await expect(validateUrlForSSRF('http://[fec0::1]/')).rejects.toThrow();
  });

  it('blocks 6to4 (2002::/16) and Teredo (2001:0::/32) tunnel literals', async () => {
    // 2002:7f00:1:: tunnels 127.0.0.x; both transitional ranges are deprecated.
    await expect(validateUrlForSSRF('http://[2002:7f00:1::]/')).rejects.toThrow();
    await expect(validateUrlForSSRF('http://[2001:0:0:0:0:0:7f00:1]/')).rejects.toThrow();
  });

  it('blocks the NAT64 well-known prefix (64:ff9b::/96) wrapping cloud metadata', async () => {
    // On a host whose outbound path traverses a NAT64 gateway (464XLAT on
    // IPv6-only mobile/enterprise networks), this address is network-layer
    // translated to a direct connection to the embedded IPv4. Node's URL
    // parser normalizes the dotted-decimal tail to hex before this ever runs
    // (64:ff9b::169.254.169.254 → 64:ff9b::a9fe:a9fe), so both forms must block.
    await expect(validateUrlForSSRF('http://[64:ff9b::169.254.169.254]/')).rejects.toThrow();
    await expect(validateUrlForSSRF('http://[64:ff9b::a9fe:a9fe]/')).rejects.toThrow();
  });

  it('does NOT over-block real public IPv6 (Google DNS 2001:4860:4860::8888)', async () => {
    await expect(validateUrlForSSRF('http://[2001:4860:4860::8888]/')).resolves.toBeUndefined();
  });

  it('does NOT over-block a public IPv4-mapped address [::ffff:8.8.8.8]', async () => {
    // 8.8.8.8 is public — the mapped-IPv4 decode must not misclassify it.
    // (No DNS is performed for an IP literal, so this resolves synchronously.)
    await expect(validateUrlForSSRF('http://[::ffff:8.8.8.8]/')).resolves.toBeUndefined();
  });

  it('the loopback flag relaxes ONLY mapped loopback, not mapped LAN', async () => {
    process.env[FLAG] = 'true';
    await expect(validateUrlForSSRF('http://[::ffff:127.0.0.1]/')).resolves.toBeUndefined();
    await expect(validateUrlForSSRF('http://[::ffff:10.0.0.1]/')).rejects.toThrow();
  });
});
