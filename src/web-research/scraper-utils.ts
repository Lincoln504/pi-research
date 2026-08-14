/**
 * Scraper Utilities
 */

import * as dns from 'node:dns/promises';
import * as dnsCb from 'node:dns';
import * as net from 'node:net';
import crypto from 'node:crypto';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { errorTracker } from '../utils/error-tracker.ts';
import { metrics } from '../utils/metrics.ts';
import { logger } from '../logger.ts';
import {
  USER_AGENTS,
  FILTERED_TAGS,
  IMAGE_LINK_PATTERN,
  MARKDOWN_IMAGE_PATTERN,
  BOT_PATTERNS,
  INTERNAL_NETWORK_PATTERNS,
  type NativeHtmlToMarkdownModule,
} from './scraper-types.ts';
import { isCloudflareBlockError, isTaskTimeoutError, isPoolShutdownError } from '../infrastructure/browser/browser-error-utils.ts';

/**
 * True when a scrape failure is an EXPECTED per-URL outcome rather than an engine
 * fault. Scraping the open web routinely hits bot-protection interstitials, thin
 * "stub" pages, HTTP 4xx/5xx, slow/unresponsive remotes, and (on quit) pool-drain
 * races. None of these is a pi-research bug: the URL is already accounted for as
 * "not scraped" (scrape_results_total{outcome=total_failure}) and surfaced to the
 * user that way, and no operator action follows. Callers use this to log such
 * failures at debug instead of error — keeping the ERROR log (and, via
 * logger.error's error-tracker re-track, the diagnostic error count) focused on
 * genuine faults. The messages matched here are produced by validateContent
 * (`Fetch blocked:` / `Fetch returned stub:`), scrapeWithFetch (`HTTP <code>`)
 * and extractPdfToMarkdown (`Could not extract content from PDF`, `PDF too
 * large`) — a malformed/encrypted/scanned-image-only PDF, or one that simply
 * exceeds the deliberate 100MB policy cap, is routine on the open web and
 * just as non-actionable as a stub page or a 404; the remaining cases
 * delegate to the shared browser-layer predicates. Deliberately does NOT
 * match 'PDF extraction unavailable' (a pdf-oxide-wasm native-module load
 * failure) — that is an infrastructure fault affecting every URL, not a
 * routine per-PDF outcome, and must still surface at ERROR.
 */
export function isBenignScrapeFailure(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.startsWith('Fetch blocked:') ||                  // bot-protection interstitial (Cloudflare, DDoS-Guard, …)
    msg.startsWith('Fetch returned stub:') ||             // nav-only / near-empty page
    msg.startsWith('Could not extract content from PDF') || // malformed/encrypted/scanned-only PDF
    msg.startsWith('PDF too large') ||                    // exceeds the deliberate 100MB policy cap
    /^HTTP \d{3}\b/.test(msg) ||                          // remote 4xx/5xx status
    isCloudflareBlockError(error) ||
    isTaskTimeoutError(error) ||
    isPoolShutdownError(error)
  );
}

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
 * Synchronous SSRF screen: protocol, localhost, internal-network patterns, and
 * IP-literal private/reserved ranges. Performs NO DNS resolution, so it is cheap
 * enough to run on every browser subresource request without adding latency.
 *
 * Returns `true` when the target was definitively ACCEPTED via the test-only
 * loopback affordance (the caller must do no further checks — a DNS pass would
 * reject localhost→127.0.0.1). Returns `false` when the URL passed the sync
 * screen but a DNS-resolution pass is still warranted (validateUrlForSSRF adds
 * it). Throws on a blocked target.
 */
export function validateUrlForSSRFSync(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url' });
    throw new Error(`Invalid URL: ${url}`, { cause: e });
  }

  // Strip the IPv6 literal brackets that `new URL` preserves ("[::1]" → "::1").
  // Without this every pattern/literal check below silently misses bracketed
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
    if (isLoopback) return true;
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

  return false;
}

/**
 * Validate URL to prevent SSRF attacks
 *
 * FIX (#8): In addition to hostname pattern checks, resolves the hostname
 * via DNS and rejects any address that resolves to a private/reserved IP.
 * This defends against DNS rebinding and AAAA-only private hosts. (Decimal/
 * octal/hex IP encodings are handled earlier: WHATWG URL parsing normalizes
 * them to dotted-quad, so the sync IP-literal gate blocks them — see the
 * comment on the DNS pass below.)
 */
export async function validateUrlForSSRF(url: string): Promise<void> {
  // Synchronous protocol/localhost/internal-pattern/IP-literal screen first.
  // A `true` return means the test-only loopback affordance accepted the target,
  // so the DNS pass (which would reject localhost→127.0.0.1) must be skipped.
  if (validateUrlForSSRFSync(url)) return;

  const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Resolve hostname via DNS (both IPv4 and IPv6) and check all resulting addresses.
  // This catches DNS rebinding, AAAA-only hosts (::1, fc00::/7) and other
  // hostname-based bypasses. (It does NOT catch numeric-encoding forms like
  // decimal 2130706433 — dns.resolve4/6 reject numeric hosts with EBADNAME — but
  // it doesn't need to: WHATWG URL parsing normalizes decimal/octal/hex IPv4
  // forms to dotted-quad before this function ever sees them, so the IP-literal
  // gate in validateUrlForSSRFSync blocks them. Pinned by a regression test.)
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
 * SSRF-safe DNS lookup for the connect layer.
 *
 * validateUrlForSSRF runs at request time, but Node's fetch independently
 * re-resolves the hostname when it opens the socket. A DNS-rebinding attacker
 * with a TTL-0 record can answer with a public IP during validation and a
 * private one (e.g. the cloud metadata endpoint 169.254.169.254) at connect —
 * a classic time-of-check/time-of-use gap. This lookup closes it: it is wired
 * into the undici connector (see getSsrfSafeDispatcher) so the address the
 * socket actually connects to is the address that gets validated. Any resolved
 * private/reserved address is filtered out, and a host that resolves ONLY to
 * private addresses is refused at connect time.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: dnsCb.LookupAllOptions | dnsCb.LookupOneOptions | number | undefined,
  callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void,
  // Resolver is injectable for tests; undici calls with the standard 3 args.
  resolveImpl: (hostname: string, opts: dnsCb.LookupAllOptions, cb: (err: NodeJS.ErrnoException | null, addresses: dnsCb.LookupAddress[]) => void) => void = dnsCb.lookup as any,
): void {
  const family = typeof options === 'number' ? options : (options?.family ?? 0);
  const wantsAll = typeof options === 'object' && options?.all === true;
  // Mirror validateUrlForSSRF's loopback test affordance: when explicitly
  // enabled, integration tests resolve to 127.0.0.1/::1 and must be allowed to
  // connect. Scoped to loopback only — other private ranges stay blocked.
  const allowLoopback = process.env['PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE'] === 'true';
  const isLoopback = (a: { address: string; family: number }): boolean =>
    a.family === 6
      ? (a.address.toLowerCase() === '::1' || isMappedLoopback(a.address))
      : /^127\./.test(a.address);
  resolveImpl(hostname, { all: true, verbatim: true, family }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [];
    const safe = list.filter((a) => {
      if (!a) return false;
      if (allowLoopback && isLoopback(a)) return true;
      return a.family === 6 ? !isPrivateIpv6(a.address) : !isPrivateIp(a.address);
    });
    if (safe.length === 0) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'connect_time_private' });
      return callback(
        Object.assign(new Error(`SSRF blocked: ${hostname} resolved only to private/reserved addresses at connect time`), { code: 'ESSRFBLOCKED' }),
      );
    }
    if (wantsAll) return callback(null, safe);
    return callback(null, safe[0]!.address, safe[0]!.family);
  });
}

// undici Agent used as the per-request dispatcher for scrape fetches. Cached
// after first construction. `undefined` = not yet attempted, `null` = undici
// unavailable (fall back to plain fetch with request-time validation only).
let cachedSsrfDispatcher: unknown | null | undefined = undefined;

/**
 * Build (once) an undici Agent whose connector resolves via ssrfSafeLookup, so
 * every scrape fetch — including each manually-followed redirect hop — connects
 * only to a validated public address. Returns null if undici can't be loaded;
 * callers then fall back to plain fetch (request-time validation still applies).
 */
export async function getSsrfSafeDispatcher(): Promise<unknown | null> {
  if (cachedSsrfDispatcher !== undefined) return cachedSsrfDispatcher as unknown | null;
  try {
    const { Agent } = await import('undici');
    cachedSsrfDispatcher = new Agent({ connect: { lookup: ssrfSafeLookup } });
  } catch (e) {
    logger.warn(`[Scrapers] undici unavailable; connect-time SSRF pinning disabled (request-time validation still active): ${e instanceof Error ? e.message : String(e)}`);
    cachedSsrfDispatcher = null;
  }
  return cachedSsrfDispatcher as unknown | null;
}

/**
 * Render an error for diagnostics, surfacing the swallowed underlying cause.
 *
 * Node's `fetch()`/undici wraps the real transport reason (ECONNRESET, ENOTFOUND,
 * a TLS error, UND_ERR_*, an AbortError) under `error.cause`, and the top-level
 * object is almost always the uninformative `TypeError: fetch failed`. Logging
 * only `String(err)` (or `err.message`) therefore records "fetch failed" and
 * discards the actual reason — which made the production scrape-failure spike
 * (212+ sub-5ms failures) impossible to diagnose from logs. This walks the
 * `cause` chain (bounded, mirroring `isTransientError`) and folds in any Node /
 * undici `.code`, so each "fetch failed" log line is self-diagnosing.
 *
 * Defensive against throwing getters and non-Error values: never throws.
 */
export function formatErrorWithCause(err: unknown): string {
  try {
    const parts: string[] = [];
    let current: unknown = err;
    for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
      let segment: string;
      if (current instanceof Error) {
        segment = current.message || current.name;
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && code && !segment.includes(code)) {
          segment = `${segment} [${code}]`;
        }
      } else if (typeof current === 'string') {
        segment = current;
      } else {
        segment = String(current);
      }
      if (segment && !parts.includes(segment)) parts.push(segment);
      const next = (current as { cause?: unknown }).cause;
      if (next === current) break; // defensive: self-referential cause
      current = next;
    }
    if (parts.length === 0) return String(err);
    return parts.length === 1 ? parts[0]! : parts.join(' ← ');
  } catch {
    return String(err);
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
  // 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (RFC 6598 CGNAT / shared address space,
  // routinely routed to internal infra by cloud/hosting providers), 127.0.0.0/8,
  // 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4 (multicast),
  // 240.0.0.0/4 (reserved)
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
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
  // Deprecated site-local (fec0::/10, RFC 3879, deprecated 2004). No OS
  // auto-routes to it today, but it's still squarely "private/reserved"
  // address space — the sibling range immediately above this one.
  if (normalized.startsWith('fec') || normalized.startsWith('fed') ||
      normalized.startsWith('fee') || normalized.startsWith('fef')) return true;
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
  // NAT64 well-known prefix (64:ff9b::/96, RFC 6052) also tunnels an IPv4
  // address, and unlike the transitional ranges above it's actively deployed
  // today (464XLAT on IPv6-only mobile/enterprise networks). A host whose
  // outbound path traverses a NAT64 gateway gets this transparently
  // translated to a direct connection to the embedded IPv4 (e.g. the cloud
  // metadata service) — block the whole prefix regardless of what it wraps,
  // same rationale as the 6to4/Teredo ranges just above.
  if (normalized.startsWith('64:ff9b:')) return true;
  // IPv4-COMPATIBLE ::/96 (RFC 4291 §2.5.5.1, deprecated) — the sibling of the
  // ::ffff:0:0/96 mapped range decoded above, and the last IPv4-in-IPv6 form
  // left open. `http://[::127.0.0.1]/` normalizes to `[::7f00:1]`, which matches
  // none of the checks above: not `::1`, no `fc`/`fd`/`fe8x` prefix, no `::ffff:`
  // prefix for extractMappedIpv4 to decode, and not one of the tunnel prefixes.
  // Whether it reaches the embedded IPv4 depends on the OS, an intervening
  // proxy, and NAT64 translation — the same "depends on the path" property that
  // made 6to4/Teredo/NAT64 whole-range blocks the right call, so block the whole
  // /96 rather than decode it. Deprecated with no legitimate scrape target.
  // Matched structurally (top 96 bits zero => at most two groups after `::`),
  // which is why it cannot swallow `::ffff:7f00:1` (three groups, ffff set).
  if (/^::(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)$/.test(normalized)) return true;
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
  // ::ffff: prefix, compressed or full (0:0:0:0:0:ffff:). Anchor once at the
  // start: a `^` inside the {5} group would only match the first repetition,
  // making the full-form alternative dead.
  const prefix = /^(?:::ffff:|(?:0:){5}ffff:)/i;
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
    // Compare against the lowercased pattern: htmlLow is already lowercased, so a
    // mixed-case pattern (e.g. 'Just a moment...') would otherwise never match.
    if (htmlLow.includes(pattern.toLowerCase())) {
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
  // Space-less scripts (Chinese/Japanese/Thai) have no inter-word whitespace, so a real article
  // yields very few whitespace tokens. Gate the stub check on BOTH a low word count AND a low
  // non-whitespace character count — otherwise a genuine CJK page was thrown away as a "stub",
  // silently biasing research away from the non-Latin web. A true stub (nav-only / a few words)
  // is short by both measures; a real CJK article clears the character threshold.
  const charCount = markdown.replace(/\s+/g, '').length;
  let stubCheckHostname = '';
  try { stubCheckHostname = new URL(url).hostname; } catch { /* ignore */ }
  if (words.length < 50 && charCount < 200 && stubCheckHostname !== 'example.com') {
    metrics.increment('scrape_errors_total', 1, { error_type: 'stub_content' });
    const error = new Error(`Fetch returned stub: only ${words.length} words / ${charCount} chars found.`);
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