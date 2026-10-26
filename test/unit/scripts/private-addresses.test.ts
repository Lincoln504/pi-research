/**
 * Destination guard for the SOCKS proxy (scripts/lib/private-addresses.mjs).
 *
 * The guard exists because the browser's DNS-rebinding backstop cannot run through a
 * SOCKS5 proxy (Firefox reports `0.0.0.0` as the origin address), so the proxy is the
 * only component left that can refuse to reach internal infrastructure. A regression
 * here is a silent SSRF hole, so the ranges are pinned explicitly.
 */

import { describe, it, expect } from 'vitest';
import { isBlockedDestination, isBlockedProxyTarget } from '../../../scripts/lib/private-addresses.mjs';

describe('isBlockedDestination', () => {
  it('blocks the loopback / private / link-local / reserved IPv4 space', () => {
    for (const ip of [
      '0.0.0.0', '0.1.2.3',
      '10.0.0.1', '10.255.255.254',
      '100.64.0.1', '100.127.255.254',
      '127.0.0.1', '127.1.2.3',
      '169.254.169.254', '169.254.0.1',
      '172.16.0.1', '172.31.255.254',
      '192.0.0.1', '192.0.2.5',
      '192.168.0.1', '192.168.255.254',
      '198.18.0.1', '198.19.255.254',
      '198.51.100.7', '203.0.113.9',
      '224.0.0.1', '239.255.255.250', '255.255.255.255',
    ]) {
      expect(isBlockedDestination(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4, including the pinned DuckDuckGo front-doors', () => {
    for (const ip of [
      '8.8.8.8', '1.1.1.1', '104.20.23.154',
      '52.250.42.157', '40.89.244.232', // DDG_PIN_IPS defaults
      '172.15.255.255', '172.32.0.1',   // just outside 172.16/12
      '100.63.255.255', '100.128.0.1',  // just outside 100.64/10
      '11.0.0.1', '223.255.255.255',    // just outside 10/8 and 224/4
    ]) {
      expect(isBlockedDestination(ip), ip).toBe(false);
    }
  });

  it('blocks loopback / unique-local / link-local / multicast IPv6', () => {
    for (const ip of [
      '::', '::1', '0:0:0:0:0:0:0:1',
      'fc00::1', 'fd12:3456::1',
      'fe80::1', 'febf::1',
      'ff02::1', 'ff00::',
      '[::1]', 'fe80::1%eth0',
    ]) {
      expect(isBlockedDestination(ip), ip).toBe(true);
    }
  });

  it('blocks the IPv4-tunneling ranges (site-local, 6to4, Teredo, NAT64)', () => {
    // These ranges wrap an IPv4 address inside the IPv6 literal, so a
    // public-looking literal can carry a private/loopback IPv4 — the TS
    // classifier (isPrivateIpv6) blocks the whole ranges, and this mirror
    // must stay in step with it.
    for (const ip of [
      'fec0::1', 'fdff::1', // site-local fec0::/10
      '2002:7f00:1::', '2002:127:0:0::1', // 6to4 wrapping 127.x
      '2001:0:dead::beef', // Teredo (2001:0::/32)
      '64:ff9b::a9fe:a9fe', // NAT64 wrapping 169.254.169.254
      '64:ff9b:1::',
    ]) {
      expect(isBlockedDestination(ip), ip).toBe(true);
    }
  });

  it('judges an IPv4 embedded in IPv6 by the embedded address', () => {
    // ::ffff:127.0.0.1 is loopback however it is spelled.
    expect(isBlockedDestination('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedDestination('::ffff:169.254.169.254')).toBe(true);
    expect(isBlockedDestination('::ffff:8.8.8.8')).toBe(false);
  });

  it('allows public IPv6', () => {
    for (const ip of ['2606:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1']) {
      expect(isBlockedDestination(ip), ip).toBe(false);
    }
  });

  it('fails closed on anything it cannot parse', () => {
    for (const value of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'gggg::1', '::1::']) {
      expect(isBlockedDestination(value), value).toBe(true);
    }
    // Non-string input must not throw (the proxy can hand this an empty host).
    expect(isBlockedDestination(undefined as unknown as string)).toBe(true);
  });
});

describe('isBlockedProxyTarget', () => {
  // The regression this pins: the address guard must never be handed a hostname. Every
  // hostname is unparseable as an address, so it fails closed — which, on the SOCKS path,
  // refuses EVERY request, because Firefox sends domain-type requests for every hop
  // (`socks_remote_dns: true`). A live run confirmed it before this split existed.
  it('passes ordinary hostnames through for the post-DNS check', () => {
    for (const host of [
      'example.com', 'duckduckgo.com', 'html.duckduckgo.com',
      'www.stackoverflow.com', 'developer.android.com', 'deepwiki.com',
      'duckduckgo.com.', // trailing root dot
    ]) {
      expect(isBlockedProxyTarget(host), host).toBe(false);
    }
  });

  it('refuses loopback names, which never reach DNS', () => {
    for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', 'localhost.']) {
      expect(isBlockedProxyTarget(host), host).toBe(true);
    }
  });

  it('judges IP literals immediately', () => {
    expect(isBlockedProxyTarget('127.0.0.1')).toBe(true);
    expect(isBlockedProxyTarget('169.254.169.254')).toBe(true);
    expect(isBlockedProxyTarget('0.0.0.0')).toBe(true);
    expect(isBlockedProxyTarget('::1')).toBe(true);
    expect(isBlockedProxyTarget('52.250.42.157')).toBe(false); // DDG pin
    expect(isBlockedProxyTarget('40.89.244.232')).toBe(false); // DDG pin
  });

  it('fails closed on empty input', () => {
    expect(isBlockedProxyTarget('')).toBe(true);
    expect(isBlockedProxyTarget(undefined as unknown as string)).toBe(true);
  });
});
