/**
 * Web Scraper
 *
 * 2-layer scraping architecture:
 * Layer 1: fetch (Node built-in, concurrent, no browser overhead)
 * Layer 2: Playwright + Camoufox (stealth Firefox, for JS-heavy or protected sites)
 *
 * Support: HTML and PDF (auto-detected via content-type and magic bytes).
 */

import type { ScrapeLayerResult } from './scraper-types.ts';
import { checkModule } from './utils.ts';
import { logger } from '../logger.ts';
import { runBrowserTask } from '../infrastructure/browser/task-execution-service.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import { errorTracker } from '../utils/error-tracker.ts';
import {
  MAX_HTML_SIZE,
  MAX_PDF_SIZE,
  PRIMARY_SCRAPER_TIMEOUT,
} from './scraper-types.ts';
import {
  getRandomUserAgent,
  extractDomain,
  validateUrlForSSRF,
  validateContent,
  createNativeMarkdownConverter,
  createJsMarkdownConverter,
} from './scraper-utils.ts';

let playwrightAvailable: boolean = false;
let markdownConverterPromise: Promise<(html: string) => Promise<string>> | null = null;

export function initScraperDependencies(): void {
  playwrightAvailable = checkModule('playwright-core') && checkModule('camoufox-js');
}
initScraperDependencies();

async function getMarkdownConverter(): Promise<(html: string) => Promise<string>> {
  if (markdownConverterPromise !== null) return markdownConverterPromise;

  markdownConverterPromise = (async () => {
    try {
      const nativeModule = await import('@kreuzberg/html-to-markdown-node') as unknown as import('./scraper-types.ts').NativeHtmlToMarkdownModule;
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

async function convertToMarkdown(html: string): Promise<string> {
  const converter = await getMarkdownConverter();
  return converter(html);
}

async function extractPdfToMarkdown(bytes: Uint8Array): Promise<string> {
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
      markdown += doc.toMarkdownAll();
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
    errorTracker.trackError(e instanceof Error ? e : String(e), {
      component: 'scrapers',
      operation: 'pdf-extract',
      contentType: 'pdf',
      errorType: 'extraction_failed',
    });
    return `*Error: Could not extract content from PDF (${msg}).*`;
  }
}

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  validateUrlForSSRF(url);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRIMARY_SCRAPER_TIMEOUT);
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
    
    if (html.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(html.length / 1024 / 1024);
      logger.warn(`[Scrapers] HTML response too large (actual: ${sizeMB}MB, max 25MB), truncating`);
      metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: 'html' });
      errorTracker.trackError(new Error(`HTML response too large (${sizeMB}MB, max 25MB)`), {
        component: 'scrapers',
        operation: 'fetch',
        url,
        domain: extractDomain(url),
        layer: 'fetch',
        contentType: 'html',
      });
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
      errorTracker.trackError(error, {
        component: 'scrapers',
        operation: 'fetch',
        url,
        domain: extractDomain(url),
        layer: 'fetch',
        errorType: 'ssrf_blocked',
      });
      throw error;
    }
    metrics.increment('scrape_operations_total', 1, { layer: 'fetch', status: 'error' });
    errorTracker.trackError(error instanceof Error ? error : String(error), {
      component: 'scrapers',
      operation: 'fetch',
      url,
      domain: extractDomain(url),
      layer: 'fetch',
    });
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function scrapeWithStealthBrowser(_url: string, config?: Config): Promise<ScrapeLayerResult> {
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
    
    validateContent(html, markdown, _url);
    metrics.increment('scrape_operations_total', 1, { layer: 'playwright', content_type: 'html', status: 'success' });
    metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', content_type: 'html', status: 'success' });
    return { source: 'playwright', layer: 'playwright+camoufox', markdown };
  } catch (error) {
    const browserDuration = Date.now() - browserStart;
    metrics.increment('scrape_operations_total', 1, { layer: 'playwright', status: 'error' });
    metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', status: 'error' });
    errorTracker.trackError(error, {
      component: 'scrapers',
      operation: 'scrape',
      url: _url,
      domain: extractDomain(_url),
      layer: 'playwright+camoufox',
    });
    throw error;
  }
}

export async function scrapeSingle(url: string, signal?: AbortSignal, config?: Config): Promise<any> {
  if (typeof url !== 'string' || url.includes('[') || url.includes(']')) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url_format' });
    return { url, success: false, error: 'Invalid URL format (array passed as string?)', markdown: '' };
  }
  
  const start = Date.now();
  try {
    const res = await scrapeWithFetch(url, signal);
    const duration = Date.now() - start;
    logger.log(`[Scrapers] fetch success for ${url} in ${duration}ms`);
    metrics.increment('scrape_layer_fallbacks_total', 0);
    return { ...res, url, success: true };
  } catch (e1) {
    const fetchDuration = Date.now() - start;
    logger.debug(`[Scrapers] fetch failed for ${url} in ${fetchDuration}ms: ${String(e1)}`);
    errorTracker.trackError(e1, {
      component: 'scrapers',
      operation: 'fetch',
      url,
      domain: extractDomain(url),
      layer: 'fetch',
    });
    
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
        errorTracker.trackError(e2, {
          component: 'scrapers',
          operation: 'scrape',
          url,
          domain: extractDomain(url),
          layer: 'playwright+camoufox',
          errorType: 'fallback_failed',
        });
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
  
  const successes = results.filter(r => r.success).length;
  const failures = results.length - successes;
  metrics.increment('scrape_operations_total', successes, { status: 'success' });
  metrics.increment('scrape_operations_total', failures, { status: 'error' });
  
  return results;
}

export function getDependencyStatus() {
  return { playwrightAvailable };
}