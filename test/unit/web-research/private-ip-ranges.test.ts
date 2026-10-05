/**
 * SSRF regression tests for the reserved IPv4 literals `isPrivateIp` must reject.
 *
 * These ranges were added on 2026-10-05 after a review: 198.18.0.0/15 (RFC 2544
 * benchmarking), 192.0.0.0/24 (RFC 6890 IETF protocol assignments) and the three
 * documentation ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET-1/2/3,
 * RFC 5737). None is a legitimate scrape target, and a hostile page's SSRF probe can
 * name any of them.
 *
 * `isPrivateIp` is not exported, so these drive it through the public literal screen
 * `validateUrlForSSRFSync`: it THROWS on a blocked target and returns `false` when the
 * sync screen passed (a DNS pass is then still warranted, which is irrelevant for an IP
 * literal). The neighbouring public addresses are asserted too, so a future range edit
 * cannot silently over-block legitimate scraping.
 */

import { describe, it, expect } from 'vitest';
import { validateUrlForSSRFSync } from '../../../src/web-research/scraper-utils.ts';

const blocked = [
  // RFC 2544 benchmarking
  'http://198.18.0.1/',
  'http://198.19.255.254/',
  // RFC 6890 IETF protocol assignments + TEST-NET-1
  'http://192.0.0.1/',
  'http://192.0.2.1/',
  // TEST-NET-2 and TEST-NET-3
  'http://198.51.100.7/',
  'http://203.0.113.9/',
  // Pre-existing coverage, kept here so one file states the whole literal screen
  'http://10.0.0.1/',
  'http://100.64.0.1/',
  'http://127.0.0.1/',
  'http://169.254.1.1/',
  'http://172.16.0.1/',
  'http://192.168.1.1/',
  'http://224.0.0.1/',
  'http://0.0.0.0/',
];

const allowed = [
  // The immediate neighbours of every newly blocked range
  'http://198.20.0.1/',
  'http://198.17.255.254/',
  'http://192.0.3.1/',
  'http://192.0.1.1/',
  'http://198.51.101.1/',
  'http://198.50.100.1/',
  'http://203.0.114.1/',
  'http://203.1.113.1/',
  // Ordinary public addresses
  'http://1.1.1.1/',
  'http://93.184.216.34/',
];

describe('isPrivateIp: newly blocked reserved ranges', () => {
  it.each(blocked)('throws on %s', (url) => {
    expect(() => validateUrlForSSRFSync(url)).toThrow();
  });

  it.each(allowed)('passes the literal screen for the public neighbour %s', (url) => {
    expect(validateUrlForSSRFSync(url)).toBe(false);
  });
});
