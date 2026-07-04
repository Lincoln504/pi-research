/**
 * URL Utilities
 *
 * Unified functions for URL normalization and validation used across the
 * knowledge store, writer queue, and shared link registry.
 */

import { logger } from '../logger.ts';

/**
 * Strips trailing punctuation an LLM commonly appends to a URL in prose
 * (sentence periods, list commas, markdown emphasis/code markers) WITHOUT
 * corrupting the URL itself:
 * - A trailing ')' is removed only when it is unbalanced (e.g. from "(see http://x)").
 *   A balanced ')' is part of the URL — e.g. Wikipedia's
 *   "…/Python_(programming_language)" — and is preserved.
 * - '_' and '~' are RFC 3986 unreserved characters and are legitimate at the
 *   end of a URL, so they are never stripped (in the main parse path a leading
 *   markdown marker would have made new URL() throw and diverted to the
 *   aggressive fallback, so a trailing one here is far more likely genuine).
 * The loop is bounded to defend against pathological input (ReDoS-free).
 */
export function stripTrailingLlmPunctuation(input: string): string {
  let s = input;
  for (let i = 0; i < 25 && s.length > 0; i++) {
    const last = s[s.length - 1]!;
    if (last === '*' || last === '`' || last === '.' || last === ',') {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let opens = 0;
      let closes = 0;
      for (const ch of s) {
        if (ch === '(') opens++;
        else if (ch === ')') closes++;
      }
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

/**
 * Normalizes a URL for consistent deduplication and storage.
 * 
 * Features:
 * - Forces HTTPS (deduplicates http/https as the same content)
 * - Lowercases hostname
 * - Removes default ports (80 for http, 443 for https)
 * - Removes ALL hash fragments
 * - Sorts query parameters for consistent ordering
 * - Strips trailing slashes from pathnames
 * - Strips trailing markdown markers (e.g. **) or trailing punctuation
 *
 * @param url - The URL to normalize
 * @returns The normalized URL string, or the original string if parsing fails
 */
export function normalizeUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;

  try {
    // Guard against pathological inputs (ReDoS defense for subsequent regex)
    if (url.length > 4096) return url.trim().split('#')[0]!.toLowerCase();
    // 1. Strip trailing markdown markers and punctuation often found in LLM output
    //    (balanced parens and unreserved trailing chars are preserved).
    const cleanUrl = stripTrailingLlmPunctuation(url.trim());
    
    const parsed = new URL(cleanUrl);
    
    // 2. Force HTTPS (dedup check)
    parsed.protocol = 'https:';
    
    // 3. Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();
    
    // 4. Remove default ports
    if (parsed.port === '443' || parsed.port === '80') {
      parsed.port = '';
    }
    
    // 5. Remove all hash fragments
    parsed.hash = '';
    
    // 6. Sort query parameters
    parsed.searchParams.sort();
    
    // 7. Strip trailing slashes from pathname (URL forces / for root, so we keep length > 1)
    while (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      const trimmed = parsed.pathname.slice(0, -1);
      parsed.pathname = trimmed;
      // Non-special-scheme URLs (e.g. "foo.bar:baz/") carry an opaque path whose
      // setter silently ignores assignment. Without this guard the loop would
      // spin forever on such input — a synchronous infinite loop that even
      // blocks vitest's own test timeout. Bail the instant a write doesn't take.
      if (parsed.pathname !== trimmed) break;
    }
    
    let result = parsed.toString();
    
    // 8. Final cleanup: strip trailing slash and question mark
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    if (result.endsWith('?')) {
      result = result.slice(0, -1);
    }
    
    return result;
  } catch (_err) {
    // Fallback for invalid URLs: aggressive best-effort normalization.
    // LLM hallucinations often produce broken URLs — log a warning so we can
    // trace them, then do our best to clean them for dedup purposes.
    logger.debug(`[url-utils] normalizing unparseable URL (${url.slice(0, 200)}): ${_err instanceof Error ? _err.message : String(_err)}`);
    
    let cleaned = url.trim()
      // Strip leading/trailing markdown and punctuation often added by LLMs.
      // Quantifiers are bounded ({1,20}) rather than unbounded (+) to avoid a
      // polynomial-backtracking (ReDoS) regex on unsanitized URL input; no
      // legitimate URL carries 20+ leading/trailing punctuation characters.
      .replace(/^[*_~`"']{1,20}/, '')
      .replace(/[*_~`"',.)}\]]{1,20}$/, '');
    
    // Strip hash fragment (best-effort)
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx >= 0) cleaned = cleaned.substring(0, hashIdx);
    
    // Strip trailing slash
    if (cleaned.endsWith('/') && cleaned.length > 8) {
      cleaned = cleaned.slice(0, -1);
    }
    
    // Lowercase everything
    cleaned = cleaned.toLowerCase();
    
    // Try to force https:// prefix if it looks like a domain
    if (!cleaned.startsWith('http') && cleaned.includes('.')) {
      cleaned = 'https://' + cleaned.replace(/^\/{2,}/, '');
    }
    
    return cleaned;
  }
}

// ---------------------------------------------------------------------------
// Initial-links validation (shared by the CLI --initial-links flag and the
// research tool's initialLinks parameter, so the two paths cannot drift).
// These links are templated verbatim into the researcher prompt as trusted
// seed evidence, so they must be bounded and shape-checked at every entry
// point: http(s)-only, ≤ MAX_INITIAL_LINK_CHARS each, ≤ MAX_INITIAL_LINKS.
// ---------------------------------------------------------------------------

/** Maximum number of initial/seed links a caller may provide. */
export const MAX_INITIAL_LINKS = 20;

/** Maximum length (chars) of each initial/seed link. */
export const MAX_INITIAL_LINK_CHARS = 2048;

/**
 * Validate a single initial/seed link.
 * @returns null when valid, or a human-readable reason (no trailing period).
 */
export function validateInitialLink(link: string): string | null {
  if (link.length > MAX_INITIAL_LINK_CHARS) {
    return `each URL must be at most ${MAX_INITIAL_LINK_CHARS} characters`;
  }
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return `"${link}" is not a valid URL`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'only http(s) URLs are allowed';
  }
  return null;
}

/**
 * Validate a full initialLinks array (count cap + per-link checks).
 * @returns null when valid, or a human-readable reason (no trailing period).
 */
export function validateInitialLinks(links: readonly string[]): string | null {
  if (links.length > MAX_INITIAL_LINKS) {
    return `at most ${MAX_INITIAL_LINKS} URLs may be provided`;
  }
  for (const link of links) {
    const err = validateInitialLink(link);
    if (err) return err;
  }
  return null;
}

/**
 * Validates URL format and applies basic SSRF defense-in-depth.
 *
 * Rejects:
 * - Non-HTTP/HTTPS protocols
 * - Localhost, loopback, and private network ranges
 * - Hostnames without a public TLD (e.g. .local, .internal)
 * - Obvious hallucinations or malformed strings
 *
 * @param url - The URL to validate
 * @returns True if the URL is considered safe and valid for research
 */
export function validateUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const parsed = new URL(url);
    
    // Only allow HTTP/HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    
    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) return false;
    
    // SSRF Defense: Reject localhost and loopback
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
    if (hostname === '::1' || hostname === '[::1]') return false;
    
    // SSRF Defense: Reject private/internal IP ranges
    // IPv4: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.x
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.)/.test(hostname)) return false;
    
    // IPv6 private ranges
    // Note: new URL().hostname wraps IPv6 literals in brackets, so IPv6 ranges
    // must be matched on the bracketed form. Matching the bracketless prefix
    // (e.g. "fc"/"fd") would instead reject ordinary domains like fc2.com,
    // fcc.gov, fda.gov and fdic.gov — a false-negative, not SSRF protection
    // (the connect-time IP pin in validateUrlForSSRF is the real gate).
    if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) return false;
    if (hostname.startsWith('[fc') || hostname.startsWith('[fd')) return false;
    if (hostname.startsWith('::ffff:') || hostname.startsWith('[::ffff:')) return false;
    
    // Reject hostnames without a public TLD or with internal suffixes
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    if (!hostname.includes('.')) return false; // Must have at least one dot (e.g. example.com)
    
    return true;
  } catch {
    return false;
  }
}
