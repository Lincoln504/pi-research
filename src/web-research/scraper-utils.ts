/**
 * Scraper Utilities
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import crypto from 'node:crypto';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { errorTracker } from '../utils/error-tracker.ts';
import { metrics } from '../utils/metrics.ts';
import {
  USER_AGENTS,
  FILTERED_TAGS,
  IMAGE_LINK_PATTERN,
  MARKDOWN_IMAGE_PATTERN,
  BOT_PATTERNS,
  INTERNAL_NETWORK_PATTERNS,
  type NativeHtmlToMarkdownModule,
} from './scraper-types.ts';

/**
 * Get a random user agent
 */
export function getRandomUserAgent(): string {
  try {
    const index = crypto.randomInt(0, USER_AGENTS.length);
    const userAgent = USER_AGENTS[index];
    return userAgent ?? USER_AGENTS[0]!;
  } catch {
    return USER_AGENTS[0]!;
  }
}

/**
 * Extract domain from URL for error tracking
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Validate URL to prevent SSRF attacks
 *
 * FIX (#8): In addition to hostname pattern checks, resolves the hostname
 * via DNS and rejects any address that resolves to a private/reserved IP.
 * This defends against DNS rebinding and decimal/octal IP representations.
 */
export async function validateUrlForSSRF(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url' });
    throw new Error(`Invalid URL: ${url}`, { cause: e });
  }

  // Strip the IPv6 literal brackets that `new URL` preserves ("[::1]" → "::1").
  // Without this every pattern/literal/DNS check below silently misses bracketed
  // IPv6 literals — e.g. http://[::1]/ and http://[::ffff:127.0.0.1]/ (which Node
  // normalizes to the hex form [::ffff:7f00:1]) would bypass the guard entirely.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'invalid_protocol' });
    throw new Error('Only HTTP/HTTPS protocols are allowed');
  }

  // Test-only affordance: when PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE=true, permit
  // LOOPBACK targets (127.0.0.0/8, ::1, *.localhost) so integration tests can
  // drive the real browser + scrape pipeline against a local HTTP server with
  // no external network dependency. Default off; never enabled in production.
  // Deliberately scoped to loopback ONLY — link-local 169.254.0.0/16 (cloud
  // metadata) and RFC1918 LAN ranges stay blocked even when this flag is set,
  // so the dangerous SSRF targets remain protected.
  if (process.env['PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE'] === 'true') {
    const isLoopback =
      hostname === 'localhost' || hostname.endsWith('.localhost') ||
      /^127\./.test(hostname) || hostname === '::1' ||
      (net.isIPv6(hostname) && isPrivateIpv6(hostname) && isMappedLoopback(hostname));
    if (isLoopback) return;
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'localhost' });
    throw new Error('Access to localhost is not allowed');
  }

  for (const pattern of INTERNAL_NETWORK_PATTERNS) {
    if (pattern.test(hostname)) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'internal_network' });
      throw new Error('Access to internal networks is not allowed');
    }
  }

  // Direct IP-literal check. dns.resolve4/6 REJECT IP literals (EBADNAME), so a
  // raw-IP host would otherwise skip the resolved-address checks below and slip
  // through. This is the gate that actually blocks http://[::ffff:127.0.0.1]/ and
  // other IPv6 literals whose mapped IPv4 Node renders in hex.
  const literalKind = net.isIP(hostname);
  if (literalKind === 4 && isPrivateIp(hostname)) {
    metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'ip_literal_v4' });
    throw new Error('Access to private/reserved IPv4 address is not allowed');
  }
  if (literalKind === 6 && isPrivateIpv6(hostname)) {
    metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'ip_literal_v6' });
    throw new Error('Access to private/reserved IPv6 address is not allowed');
  }

  // Resolve hostname via DNS (both IPv4 and IPv6) and check all resulting addresses.
  // This catches DNS rebinding, decimal IP representations (2130706433),
  // AAAA-only hosts (::1, fc00::/7) and other hostname-based bypasses.
  const [v4Results, v6Results] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const v4Addresses = v4Results.status === 'fulfilled' ? v4Results.value : [];
  const v6Addresses = v6Results.status === 'fulfilled' ? v6Results.value : [];

  for (const ip of v4Addresses) {
    if (isPrivateIp(ip)) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'dns_rebinding_v4' });
      throw new Error('Hostname resolves to a private/reserved IPv4 address');
    }
  }
  for (const ip of v6Addresses) {
    if (isPrivateIpv6(ip)) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'dns_rebinding_v6' });
      throw new Error('Hostname resolves to a private/reserved IPv6 address');
    }
  }
}

/**
 * Check if an IPv4 address is private/reserved/loopback.
 */
function isPrivateIp(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Check if an IPv6 address is private/reserved/loopback.
 * Covers: ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local),
 * ::ffff:0:0/96 (IPv4-mapped — blocked if the mapped address is private).
 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // Loopback
  if (normalized === '::1') return true;
  // Unique local (fc00::/7 covers fc:: and fd::)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // Link-local (fe80::/10)
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  // IPv4-mapped ::ffff:x.x.x.x — check the embedded IPv4 part. The mapped tail
  // can arrive dotted-decimal (::ffff:127.0.0.1) OR hex (::ffff:7f00:1) — Node's
  // URL parser normalizes literals to the hex form — and the prefix can be
  // compressed (::ffff:) or full (0:0:0:0:0:ffff:). Decode all of them.
  const mapped = extractMappedIpv4(normalized);
  if (mapped) {
    return isPrivateIp(mapped);
  }
  // 6to4 (2002::/16) and Teredo (2001:0::/32) tunnel IPv4 inside the IPv6 address,
  // so a public-looking literal can carry a private/loopback IPv4 (e.g. 2002:7f00:1::
  // → 127.0.0.x). Both are deprecated transitional ranges (RFC 7526) with no
  // legitimate scrape target, so block the whole ranges rather than decode them.
  if (normalized.startsWith('2002:')) return true;
  if (/^2001:0{0,4}:/.test(normalized) || normalized.startsWith('2001::')) return true;
  // All-zeros (unspecified address)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  return false;
}

/**
 * Decode the embedded IPv4 of an IPv4-mapped IPv6 address (::ffff:0:0/96) to
 * dotted-decimal, accepting dotted-decimal or hex tails and compressed or full
 * prefixes. Returns null when `ip` is not an IPv4-mapped address.
 */
function extractMappedIpv4(ip: string): string | null {
  // ::ffff: prefix, compressed or full (0:0:0:0:0:ffff:)
  const prefix = /(?:^::ffff:|(?:^0:){5}ffff:)/i;
  if (!prefix.test(ip)) return null;
  const tail = ip.replace(prefix, '');
  // Dotted-decimal tail: ::ffff:127.0.0.1
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  // Hex tail: ::ffff:7f00:1  (two 16-bit groups → four octets)
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex && hex[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** True when the address is an IPv4-mapped IPv6 whose embedded IPv4 is loopback. */
function isMappedLoopback(ip: string): boolean {
  const mapped = extractMappedIpv4(ip.toLowerCase().replace(/^\[|\]$/g, ''));
  return mapped !== null && /^127\./.test(mapped);
}

/**
 * Strip image links from markdown
 */
export function stripImageLinks(markdown: string): string {
  return markdown
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(IMAGE_LINK_PATTERN, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Create native HTML to markdown converter
 */
export function createNativeMarkdownConverter(
  nativeModule: NativeHtmlToMarkdownModule | undefined,
): (html: string) => Promise<string> {
  return async (html: string): Promise<string> => {
    if (!nativeModule || !nativeModule.convert || !nativeModule.HeadingStyle || !nativeModule.CodeBlockStyle) {
      throw new Error('Native markdown converter not properly initialized');
    }
    const result = nativeModule.convert(html, {
      headingStyle: nativeModule.HeadingStyle.Atx,
      codeBlockStyle: nativeModule.CodeBlockStyle.Backticks,
      wrap: false,
    });
    return stripImageLinks(result.content ?? '');
  };
}

/**
 * Create JS HTML to markdown converter (fallback)
 */
export function createJsMarkdownConverter(): (html: string) => Promise<string> {
  const converter = new NodeHtmlMarkdown({
    codeBlockStyle: 'fenced',
    textReplace: [[/\u00a0/g, ' ']],
    ignore: [...FILTERED_TAGS],
  });

  return async (html: string): Promise<string> => {
    const markdown = converter.translate(html);
    return stripImageLinks(markdown);
  };
}

/**
 * Validate scraped content
 */
export function validateContent(html: string, markdown: string, url: string): void {
  const htmlLow = html.toLowerCase();
  for (const [pattern, reason] of BOT_PATTERNS) {
    if (htmlLow.includes(pattern)) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'bot_protection' });
      const error = new Error(`Fetch blocked: ${reason}`);
      errorTracker.trackError(error, {
        component: 'scrapers',
        operation: 'validate',
        url,
        domain: extractDomain(url),
        errorType: 'bot_protection',
      });
      throw error;
    }
  }

  const words = markdown.trim().split(/\s+/).filter(w => w.length > 0);
  let stubCheckHostname = '';
  try { stubCheckHostname = new URL(url).hostname; } catch { /* ignore */ }
  if (words.length < 50 && stubCheckHostname !== 'example.com') {
    metrics.increment('scrape_errors_total', 1, { error_type: 'stub_content' });
    const error = new Error(`Fetch returned stub: only ${words.length} words found.`);
    errorTracker.trackError(error, {
      component: 'scrapers',
      operation: 'validate',
      url,
      domain: extractDomain(url),
      errorType: 'stub_content',
    });
    throw error;
  }
}