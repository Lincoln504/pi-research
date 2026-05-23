/**
 * Web Research Extension - Scrapers
 *
 * 2-layer scraping architecture:
 * Layer 1: fetch (Node built-in, concurrent, no browser overhead)
 * Layer 2: Playwright + Camoufox (stealth Firefox, for JS-heavy or protected sites)
 *
 * Support: HTML and PDF (auto-detected via content-type and magic bytes).
 */

import {
  PRIMARY_SCRAPER_TIMEOUT,
  type ScrapeLayerResult,
} from './types.ts';
import {
  checkModule,
} from './utils.ts';
import { logger } from '../logger.ts';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { runBrowserTask } from '../infrastructure/browser-manager.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import crypto from 'node:crypto';

// ============================================================================
// Constants and Configuration
// ============================================================================

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function getRandomUserAgent(): string {
  try {
    const buffer = crypto.randomBytes(1);
    const byte = buffer[0];
    const index = byte !== undefined ? Math.floor(byte / 256 * USER_AGENTS.length) : 0;
    const userAgent = USER_AGENTS[index];
    if (!userAgent) {
      return USER_AGENTS[0]!;
    }
    return userAgent!;
  } catch {
    return USER_AGENTS[0]!; // Fallback
  }
}

interface NativeJsNodeContext {
  tagName: string;
}

interface NativeHtmlToMarkdownModule {
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

/**
 * Robustly extract text from PDF bytes using pdf-oxide-wasm.
 */
// Size limits to prevent OOM attacks
// Note: HTML is converted to markdown which typically reduces size by 60-80%,
// so we can allow larger responses than PDF while still preventing unbounded memory usage
const MAX_HTML_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100MB

// FIX: SSRF protection - prevent access to internal networks
// These patterns prevent SSRF attacks by blocking access to:
// - localhost (127.x.x.x, 0.x.x.x, ::1, ::ffff:127.x.x.x)
// - link-local addresses (169.254.x.x, fe80::, ::ffff:169.254.x.x)
// - private networks (10.x.x.x, 192.168.x.x, 172.16-31.x.x, and their IPv4-mapped IPv6 versions)
// - IPv6 unique local addresses (fc00::, fd00::)
const INTERNAL_NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
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

function validateUrlForSSRF(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    // Check for localhost
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'localhost' });
      throw new Error('Access to localhost is not allowed');
    }
    
    // Check for internal network patterns
    for (const pattern of INTERNAL_NETWORK_PATTERNS) {
      if (pattern.test(hostname)) {
        metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'internal_network' });
        throw new Error('Access to internal networks is not allowed');
      }
    }
    
    // Additional safety: check for non-HTTP protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'invalid_protocol' });
      throw new Error('Only HTTP/HTTPS protocols are allowed');
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('not allowed')) {
      throw e; // Re-throw our validation errors
    }
    // Invalid URL is a different issue, let it bubble up
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url' });
    throw new Error(`Invalid URL: ${url}`, { cause: e });
  }
}

async function extractPdfToMarkdown(bytes: Uint8Array): Promise<string> {
    // Validate PDF size to prevent unbounded memory usage during parsing
    // Note: pdf-oxide-wasm loads the entire PDF into memory for text extraction,
    // so we limit to prevent pathological cases while allowing most web PDFs
    if (bytes.length > MAX_PDF_SIZE) {
        const sizeMB = Math.round(bytes.length / 1024 / 1024);
        logger.warn(`[Scrapers] PDF too large (${sizeMB}MB, max 100MB), skipping extraction`);
        metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'size_exceeded' });
        return `*Error: PDF too large (${sizeMB}MB, max 100MB).*`;
    }

    const pdfExtractionStart = Date.now();
    try {
        const { WasmPdfDocument } = await import('pdf-oxide-wasm');
        const doc = new WasmPdfDocument(bytes);
        const pageCount = doc.pageCount();
        
        let markdown = `# PDF Document\n\n**Pages:** ${pageCount}\n\n`;
        
        try {
            markdown += (doc as any).toMarkdownAll();
        } catch {
            for (let i = 0; i < pageCount; i++) {
                markdown += `## Page ${i + 1}\n\n${doc.toMarkdown(i)}\n\n`;
            }
        }
        
        doc.free();
        const pdfExtractionDuration = Date.now() - pdfExtractionStart;
        metrics.observe('scrape_pdf_conversion_ms', pdfExtractionDuration);
        metrics.increment('scrape_pdf_conversions_total', 1, { status: 'success', pages: String(pageCount) });
        return markdown;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Scrapers] PDF extraction failed: ${msg}`);
        metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'extraction_failed' });
        return `*Error: Could not extract content from PDF (${msg}).*`;
    }
}

// ============================================================================
// HTML to Markdown Conversion (Advanced)
// ============================================================================

let playwrightAvailable: boolean = false;
let markdownConverterPromise: Promise<(html: string) => Promise<string>> | null = null;

const FILTERED_TAGS = [
  'nav', 'header', 'footer', 'aside',
  'script', 'style', 'noscript',
  'form', 'input', 'select', 'textarea', 'button',
  'object', 'embed',
  'svg', 'symbol', 'use', 'defs', 'path', 'circle', 'rect', 'line', 'polygon',
  'img', 'iframe',
] as const;

const IMAGE_LINK_PATTERN = /\[([^\]]*)\]\((data:image\/[^)]+|[^)\s]+\.(?:svg|png|jpe?g|gif|webp|bmp|ico)(?:\?[^)]*)?)\)/gi;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*]\((?:data:image\/[^)]+|[^)\s]+)\)/gi;

export function initScraperDependencies(): void {
  playwrightAvailable = checkModule('playwright-core') && checkModule('camoufox-js');
}
initScraperDependencies();

async function convertToMarkdown(html: string): Promise<string> {
  const converter = await getMarkdownConverter();
  return converter(html);
}

async function getMarkdownConverter(): Promise<(html: string) => Promise<string>> {
  if (markdownConverterPromise !== null) return markdownConverterPromise;

  markdownConverterPromise = (async () => {
    try {
      const nativeModule = await import('@kreuzberg/html-to-markdown-node') as unknown as NativeHtmlToMarkdownModule;
      logger.debug('[Scrapers] Using native HTML-to-Markdown converter');
      return createNativeMarkdownConverter(nativeModule);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Scrapers] Native HTML-to-Markdown unavailable, falling back to pure JS converter: ${errorMessage}`);
      return createJsMarkdownConverter();
    }
  })();
  return markdownConverterPromise;
}

function createNativeMarkdownConverter(
  nativeModule: NativeHtmlToMarkdownModule,
): (html: string) => Promise<string> {
  const visitor = {
    async visitImage(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },
    async visitLink(ctxJson?: string): Promise<string> {
      const parsed = JSON.parse(ctxJson ?? '{}') as { href?: string };
      const href = parsed.href;
      if (href !== undefined && (
        href.startsWith('data:image/') ||
        href.match(/\.(svg|png|jpg|jpeg|gif|webp|bmp|ico)$/i) !== null
      )) {
        return JSON.stringify({ type: 'skip' });
      }
      return JSON.stringify({ type: 'continue' });
    },
    async visitIframe(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },
    async visitElementStart(ctxJson?: string): Promise<string> {
      const ctx = JSON.parse(ctxJson ?? '{}') as Partial<NativeJsNodeContext>;
      if (ctx.tagName !== undefined && (FILTERED_TAGS as readonly string[]).includes(ctx.tagName)) {
        return JSON.stringify({ type: 'skip' });
      }
      return JSON.stringify({ type: 'continue' });
    },
  };

  return async (html: string): Promise<string> => {
    const markdown = await nativeModule.convertWithVisitor(html, {
      headingStyle: nativeModule.JsHeadingStyle.Atx,
      codeBlockStyle: nativeModule.JsCodeBlockStyle.Backticks,
      wrap: false,
    }, visitor);
    return stripImageLinks(markdown);
  };
}

function createJsMarkdownConverter(): (html: string) => Promise<string> {
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

function stripImageLinks(markdown: string): string {
  return markdown
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(IMAGE_LINK_PATTERN, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================================
// Content Validation
// ============================================================================

const BOT_PATTERNS: ReadonlyArray<[string, string]> = [
  ['_cf_chl_', 'Cloudflare challenge'],
  ['cdn-cgi/challenge-platform', 'Cloudflare challenge platform'],
  ['ddos-guard', 'DDoS-Guard challenge'],
];

function validateContent(html: string, markdown: string, url: string): void {
  const htmlLow = html.toLowerCase();
  for (const [pattern, reason] of BOT_PATTERNS) {
    if (htmlLow.includes(pattern)) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'bot_protection' });
      throw new Error(`Fetch blocked: ${reason}`);
    }
  }

  const words = markdown.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 50 && !url.includes('example.com')) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'stub_content' });
    throw new Error(`Fetch returned stub: only ${words.length} words found.`);
  }
}

// ============================================================================
// Layer 1: Fetch
// ============================================================================

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  // FIX: Validate URL to prevent SSRF attacks
  validateUrlForSSRF(url);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRIMARY_SCRAPER_TIMEOUT);
  // unref() to allow clean exit if this is the only timer keeping the event loop alive
  if (timeoutId.unref) {
      timeoutId.unref();
  }
  const onAbort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const fetchStart = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'http_error', status_code: String(response.status) });
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const fetchDuration = Date.now() - fetchStart;
    
    // FIX: Check response size to prevent OOM attacks
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
        if (size > MAX_PDF_SIZE) {
          const sizeMB = Math.round(size / 1024 / 1024);
          logger.warn(`[Scrapers] PDF too large (Content-Length: ${sizeMB}MB, max 100MB), skipping`);
          metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'size_exceeded' });
          throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
        }
      } else if (size > MAX_HTML_SIZE) {
        const sizeMB = Math.round(size / 1024 / 1024);
        logger.warn(`[Scrapers] HTML response too large (Content-Length: ${sizeMB}MB, max 25MB), skipping`);
        metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: contentType.split(';')[0] || 'unknown' });
        throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`);
      }
    }
    
    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buffer = await response.arrayBuffer();
      const markdown = await extractPdfToMarkdown(new Uint8Array(buffer));
      validateContent('', markdown, url);
      metrics.increment('scrape_operations_total', 1, { layer: 'fetch', content_type: 'pdf', status: 'success' });
      metrics.observe('scrape_latency_ms', fetchDuration, { layer: 'fetch', content_type: 'pdf', status: 'success' });
      return { source: 'fetch', layer: 'fetch', markdown };
    }

    const html = await response.text();
    
    // Double-check size for HTML (in case Content-Length was missing or incorrect)
    if (html.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(html.length / 1024 / 1024);
      logger.warn(`[Scrapers] HTML response too large (actual: ${sizeMB}MB, max 25MB), truncating`);
      metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: 'html' });
      throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`);
    }
    const markdown = await convertToMarkdown(html);
    validateContent(html, markdown, url);
    metrics.increment('scrape_operations_total', 1, { layer: 'fetch', content_type: 'html', status: 'success' });
    metrics.observe('scrape_latency_ms', fetchDuration, { layer: 'fetch', content_type: 'html', status: 'success' });
    return { source: 'fetch', layer: 'fetch', markdown };
  } catch (error) {
    if (error instanceof Error && error.message.includes('not allowed')) {
      metrics.increment('scrape_operations_total', 1, { layer: 'fetch', status: 'ssrf_blocked' });
      metrics.observe('scrape_latency_ms', Date.now() - fetchStart, { layer: 'fetch', status: 'ssrf_blocked' });
      throw error;
    }
    metrics.increment('scrape_operations_total', 1, { layer: 'fetch', status: 'error' });
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ============================================================================
// Layer 2: Browser
// ============================================================================

async function scrapeWithStealthBrowser(_url: string, config?: Config): Promise<ScrapeLayerResult> {
  // Dispatch to unified worker pool (Camoufox)
  const browserStart = Date.now();
  try {
    const result = await runBrowserTask<any>(_url, 'scrape', config);
    const browserDuration = Date.now() - browserStart;

    if (result.buffer) {
        const markdown = await extractPdfToMarkdown(new Uint8Array(result.buffer));
        metrics.increment('scrape_operations_total', 1, { layer: 'playwright', content_type: 'pdf', status: 'success' });
        metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', content_type: 'pdf', status: 'success' });
        return { source: 'playwright', layer: 'playwright+camoufox', markdown };
    }

    let html = result.html || '';
    let markdown = await convertToMarkdown(html);

    // Robustness: If we got a stub, the main thread can't easily tell the worker 
    // to retry with networkidle without another roundtrip.
    // However, the unified worker now uses a standard high-fidelity wait.
    
    validateContent(html, markdown, _url);
    metrics.increment('scrape_operations_total', 1, { layer: 'playwright', content_type: 'html', status: 'success' });
    metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', content_type: 'html', status: 'success' });
    return { source: 'playwright', layer: 'playwright+camoufox', markdown };
  } catch (error) {
    const browserDuration = Date.now() - browserStart;
    metrics.increment('scrape_operations_total', 1, { layer: 'playwright', status: 'error' });
    metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', status: 'error' });
    throw error;
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function scrapeSingle(url: string, signal?: AbortSignal, config?: Config): Promise<any> {
  // Robustness: ensure we actually have a single string URL
  if (typeof url !== 'string' || url.includes('[') || url.includes(']')) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url_format' });
      return { url, success: false, error: 'Invalid URL format (array passed as string?)', markdown: '' };
  }
  
  const start = Date.now();
  try {
    const res = await scrapeWithFetch(url, signal);
    const duration = Date.now() - start;
    logger.log(`[Scrapers] fetch success for ${url} in ${duration}ms`);
    metrics.increment('scrape_layer_fallbacks_total', 0); // No fallback needed
    return { ...res, url, success: true };
  } catch (e1) {
    const fetchDuration = Date.now() - start;
    logger.debug(`[Scrapers] fetch failed for ${url} in ${fetchDuration}ms: ${String(e1)}`);
    
    if (playwrightAvailable) {
      try {
        const browserStart = Date.now();
        const res = await scrapeWithStealthBrowser(url, config);
        const browserDuration = Date.now() - browserStart;
        const totalDuration = Date.now() - start;
        logger.log(`[Scrapers] browser success for ${url} in ${browserDuration}ms (total: ${totalDuration}ms)`);
        metrics.increment('scrape_layer_fallbacks_total', 1, { from_layer: 'fetch', to_layer: 'playwright' });
        return { ...res, url, success: true };
      } catch (e2) {
        const totalDuration = Date.now() - start;
        logger.error(`[Scrapers] Browser fallback failed for ${url} in ${totalDuration}ms:`, e2);
        metrics.increment('scrape_errors_total', 1, { error_type: 'fallback_failed', layer: 'playwright' });
        return { url, success: false, error: String(e2), markdown: '' };
      }
    }
    metrics.increment('scrape_errors_total', 1, { error_type: 'no_fallback_available', layer: 'fetch' });
    return { url, success: false, error: String(e1), markdown: '' };
  }
}

export async function scrape(urls: string[], maxConcurrency = 5, signal?: AbortSignal, config?: Config): Promise<any[]> {
    metrics.increment('scrape_batches_total', 1);
    metrics.observe('scrape_urls_per_batch', urls.length);
    const batchStart = Date.now();
    
    const results: any[] = [];
    for (let i = 0; i < urls.length; i += maxConcurrency) {
        const batch = urls.slice(i, i + maxConcurrency);
        const batchRes = await Promise.all(batch.map(url => scrapeSingle(url, signal, config)));
        results.push(...batchRes);
    }
    
    const batchDuration = Date.now() - batchStart;
    metrics.observe('scrape_batch_latency_ms', batchDuration);
    
    // Count successes and failures
    const successes = results.filter(r => r.success).length;
    const failures = results.length - successes;
    metrics.increment('scrape_operations_total', successes, { status: 'success' });
    metrics.increment('scrape_operations_total', failures, { status: 'error' });
    
    return results;
}

export function getDependencyStatus() {
  return { playwrightAvailable };
}