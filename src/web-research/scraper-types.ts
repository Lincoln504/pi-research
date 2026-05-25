/**
 * Scraper Types
 */

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

export const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
] as const;

export const FILTERED_TAGS = [
  'nav', 'header', 'footer', 'aside',
  'script', 'style', 'noscript',
  'form', 'input', 'select', 'textarea', 'button',
  'object', 'embed',
  'svg', 'symbol', 'use', 'defs', 'path', 'circle', 'rect', 'line', 'polygon',
  'img', 'iframe',
] as const;

export const BOT_PATTERNS: ReadonlyArray<[string, string]> = [
  ['_cf_chl_', 'Cloudflare challenge'],
  ['cdn-cgi/challenge-platform', 'Cloudflare challenge platform'],
  ['ddos-guard', 'DDoS-Guard challenge'],
];

export const IMAGE_LINK_PATTERN = /\[([^\]]*)\]\((data:image\/[^)]+|[^)\s]+\.(?:svg|png|jpe?g|gif|webp|bmp|ico)(?:\?[^)]*)?)\)/gi;
export const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((?:data:image\/[^)]+|[^)\s]+)\)/gi;

export const PRIMARY_SCRAPER_TIMEOUT = 30000;

export interface ScrapeLayerResult {
  source: 'fetch' | 'playwright';
  layer: 'fetch' | 'playwright' | 'playwright+camoufox';
  markdown: string;
  error?: string;
}

export interface NativeJsNodeContext {
  tagName: string;
}

export interface NativeHtmlToMarkdownModule {
  convertWithVisitor(
    html: string,
    options: {
      headingStyle: unknown;
      codeBlockStyle: unknown;
      wrap: boolean;
    },
    visitor: Record<string, (_ctxJson?: string) => Promise<string>>,
  ): Promise<string>;
  JsHeadingStyle: { Atx: unknown };
  JsCodeBlockStyle: { Backticks: unknown };
}