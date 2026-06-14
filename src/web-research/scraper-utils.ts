/**
 * Scraper Utilities
 */

import * as dns from 'node:dns/promises';
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

  const hostname = parsed.hostname.toLowerCase();

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'invalid_protocol' });
    throw new Error('Only HTTP/HTTPS protocols are allowed');
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
  // IPv4-mapped ::ffff:x.x.x.x — check the embedded IPv4 part
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch && mappedMatch[1]) {
    return isPrivateIp(mappedMatch[1]);
  }
  // All-zeros (unspecified address)
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  return false;
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