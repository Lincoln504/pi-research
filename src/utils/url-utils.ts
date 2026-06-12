/**
 * URL Utilities
 *
 * Unified functions for URL normalization and validation used across the
 * knowledge store, writer queue, and shared link registry.
 */

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
    // 1. Strip trailing markdown markers and punctuation often found in LLM output
    const cleanUrl = url.trim()
      .replace(/[*_~`]+$/, '')
      .replace(/[,.)]+$/, '');
    
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
      parsed.pathname = parsed.pathname.slice(0, -1);
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
    // Fallback for invalid URLs: lowercase and basic cleanup
    let cleaned = url.trim().split('#')[0]!;
    if (cleaned.endsWith('/')) {
      cleaned = cleaned.slice(0, -1);
    }
    return cleaned.toLowerCase();
  }
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
    if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) return false;
    if (hostname.startsWith('fc') || hostname.startsWith('[fc')) return false;
    if (hostname.startsWith('fd') || hostname.startsWith('[fd')) return false;
    if (hostname.startsWith('::ffff:') || hostname.startsWith('[::ffff:')) return false;
    
    // Reject hostnames without a public TLD or with internal suffixes
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    if (!hostname.includes('.')) return false; // Must have at least one dot (e.g. example.com)
    
    return true;
  } catch {
    return false;
  }
}
