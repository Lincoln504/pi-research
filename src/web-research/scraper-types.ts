/**
 * Scraper Types
 */

import { USER_AGENTS } from '../utils/user-agent.ts';

export type FetchType = (
  _input: string | Request,
  _init?: RequestInit,
) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const fetch: FetchType;

// Size limits to prevent OOM attacks
export const MAX_HTML_SIZE = 25 * 1024 * 1024; // 25MB
export const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB

// SSRF protection patterns
export const INTERNAL_NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
  /^127\./,                        // IPv4 loopback
  /^0\./,                          // IPv4 "this" network
  /^::1$/,                         // IPv6 loopback
  /^fe80::/i,                      // IPv6 link-local
  /^fc00::/i,                      // IPv6 unique local
  /^fd00::/i,                      // IPv6 unique local
  /^169\.254\./,                   // IPv4 link-local (and metadata)
  /^10\./,                         // RFC 1918 Class A private
  /^192\.168\./,                   // RFC 1918 Class C private
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC 1918 Class B private
  /^::ffff:(127\.|0\.|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i, // IPv4-mapped IPv6
];

// USER_AGENTS re-exported from utils/user-agent.ts for convenience
export { USER_AGENTS };

export const FILTERED_TAGS = [
  'nav', 'header', 'footer', 'aside',
  'script', 'style', 'noscript',
  'form', 'input', 'select', 'textarea', 'button',
  'object', 'embed',
  'svg', 'symbol', 'use', 'defs', 'path', 'circle', 'rect', 'line', 'polygon',
  'img', 'iframe',
] as const;

/** Bot detection patterns used by scrapers and browser workers */
export const BOT_PATTERNS: ReadonlyArray<[string, string]> = [
  ['_cf_chl_', 'Cloudflare challenge'],
  ['cf_chl_opt', 'Cloudflare challenge opt'],
  ['cdn-cgi/challenge-platform', 'Cloudflare challenge platform'],
  ['ddos-guard', 'DDoS-Guard challenge'],
  ['Just a moment...', 'Cloudflare interstitial'],
  ['Checking your browser before accessing', 'Cloudflare interstitial'],
];

export const IMAGE_LINK_PATTERN = /\[([^\]]*)\]\((data:image\/[^)]+|[^)\s]+\.(?:svg|png|jpe?g|gif|webp|bmp|ico)(?:\?[^)]*)?)\)/gi;
export const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((?:data:image\/[^)]+|[^)\s]+)\)/gi;

export type { ScrapeLayerResult } from './types.ts';

export interface NativeHtmlToMarkdownModule {
  convert(
    html: string,
    options?: {
      headingStyle?: unknown;
      codeBlockStyle?: unknown;
      wrap?: boolean;
    } | null,
    visitor?: object | null,
  ): { content?: string };
  HeadingStyle: { Atx: unknown };
  CodeBlockStyle: { Backticks: unknown };
}
