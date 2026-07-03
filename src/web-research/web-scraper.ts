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
import type { ScrapeResult } from './types.ts';
import { checkModule } from './utils.ts';
import { logger } from '../logger.ts';
import { runBrowserTask } from '../infrastructure/browser/task-execution-service.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';
import { errorTracker } from '../utils/error-tracker.ts';
import {
  MAX_HTML_SIZE,
  MAX_PDF_SIZE,
} from './scraper-types.ts';
import {
  FETCH_LAYER_TIMEOUT,
} from './types.ts';
import { getRandomUserAgent, extractDomain, validateUrlForSSRF, validateContent, createNativeMarkdownConverter, createJsMarkdownConverter, getSsrfSafeDispatcher, isBenignScrapeFailure, } from './scraper-utils.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { cacheScrapedContent } from '../utils/shared-links.ts';

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
      const raw = await import('@kreuzberg/html-to-markdown-node') as unknown as import('./scraper-types.ts').NativeHtmlToMarkdownModule;
      // ESM wrapper may place the real exports on .default (CJS-in-ESM interop).
      const nativeModule = ((raw as unknown as { default?: import('./scraper-types.ts').NativeHtmlToMarkdownModule }).default ?? raw) as import('./scraper-types.ts').NativeHtmlToMarkdownModule;
      // Verify minimal required shape
      if (nativeModule && typeof nativeModule.convert === 'function') {
        logger.debug('[Scrapers] Using native HTML-to-Markdown converter');
        return createNativeMarkdownConverter(nativeModule);
      }
      throw new Error('Native module exported invalid structure');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn(`[Scrapers] Native HTML-to-Markdown unavailable, falling back to pure JS converter: ${errorMessage}`);
      return createJsMarkdownConverter();
    }
  })();

  // If the promise rejects (e.g. JS fallback also unavailable), clear the cache
  // so the next call retries rather than serving the same rejection forever.
  markdownConverterPromise.catch(() => { markdownConverterPromise = null; });

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

/**
 * Decode an HTML response body using its declared charset. response.text() blindly UTF-8-decodes,
 * corrupting non-UTF-8 pages (Shift_JIS/GBK/EUC-KR/ISO-8859-1). Prefer the Content-Type charset,
 * else sniff a <meta charset>/<meta http-equiv content=...charset=...> in the head, else UTF-8.
 * An absent/unknown charset falls back to UTF-8 (previous behavior), so UTF-8 pages are unaffected.
 */
function decodeHtmlBody(bytes: Uint8Array, contentTypeHeader: string): string {
  let charset = '';
  const fromHeader = /charset=["']?([^"';,\s]+)/i.exec(contentTypeHeader);
  if (fromHeader?.[1]) charset = fromHeader[1].toLowerCase();
  if (!charset) {
    // <meta> charset tags are ASCII, so a UTF-8 read of the first 2KB finds them regardless of the
    // body's real encoding.
    const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048));
    const fromMeta =
      /<meta[^>]+charset=["']?([\w:-]+)/i.exec(head) ||
      /<meta[^>]+content=["'][^"']*charset=([\w:-]+)/i.exec(head);
    if (fromMeta?.[1]) charset = fromMeta[1].toLowerCase();
  }
  if (!charset || charset === 'utf8') charset = 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // unknown/unsupported label → prior UTF-8 behavior
  }
}

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  await validateUrlForSSRF(url);

  // Connect-time SSRF pin: the socket connects only to a validated public IP,
  // closing the DNS-rebinding TOCTOU gap between validateUrlForSSRF (request
  // time) and fetch's own re-resolution (connect time). Null when undici is
  // unavailable — request-time validation above still applies.
  const dispatcher = await getSsrfSafeDispatcher();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_LAYER_TIMEOUT);
  safeUnref(timeoutId);
  const onAbort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const fetchStart = Date.now();
  try {
    // Manual redirect following so we can SSRF-validate each hop's Location header.
    // Using redirect:'follow' would bypass validateUrlForSSRF on 3xx targets.
    const MAX_REDIRECTS = 10;
    let currentUrl = url;
    let response!: Response;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
        },
        // RequestInit's standard type omits undici's `dispatcher`; cast to attach it.
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break; // No Location header — treat as final response
        const resolved = new URL(location, currentUrl).href;
        await validateUrlForSSRF(resolved); // Block SSRF targets in redirects
        currentUrl = resolved;
        continue;
      }
      break; // Non-redirect response
    }

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

    // Read the raw bytes and decode with the DECLARED charset. response.text() blindly UTF-8-decodes,
    // which mangles Shift_JIS/GBK/EUC-KR/ISO-8859-1 pages into mojibake that then gets cached + cited.
    // Size-check on the byte length before decoding.
    const bodyBytes = new Uint8Array(await response.arrayBuffer());

    if (bodyBytes.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(bodyBytes.length / 1024 / 1024);
      logger.warn(`[Scrapers] HTML response too large (actual: ${sizeMB}MB, max 25MB), skipping`);
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

    const html = decodeHtmlBody(bodyBytes, contentType);
    
    let markdown: string;
    try {
      markdown = await convertToMarkdown(html);
    } catch (e) {
      logger.error(`[Scrapers] Markdown conversion failed for ${url}: ${String(e)}`);
      throw new Error(`Markdown conversion failed: ${String(e)}`, { cause: e });
    }
    
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

// SSRF note: the URL is validated at request time by validateUrlForSSRF in
// scrapeSingle, and again inside the worker where every navigation gets a
// DNS-aware page.route check and each main-frame document's ACTUAL connected IP
// (response.serverAddr()) is re-validated against the SSRF policy before its body
// is returned — this closes the DNS-rebinding hole for both the initial load and
// client-side hops. The residual is the TCP connection itself (not prevented) and
// cached/service-worker responses that report no serverAddr; the rendered body is
// still withheld whenever a private/metadata IP is observed.
async function scrapeWithStealthBrowser(_url: string, config?: Config, signal?: AbortSignal, sessionId?: string, container: ServiceContainer = getServiceContainer()): Promise<ScrapeLayerResult> {
  const browserStart = Date.now();
  try {
    const result = await runBrowserTask<any>({ url: _url, sessionId }, 'scrape', config, signal, 1, container);
    const browserDuration = Date.now() - browserStart;

    if (result.buffer) {
      const markdown = await extractPdfToMarkdown(new Uint8Array(result.buffer));
      metrics.increment('scrape_operations_total', 1, { layer: 'playwright', content_type: 'pdf', status: 'success' });
      metrics.observe('scrape_latency_ms', browserDuration, { layer: 'playwright', content_type: 'pdf', status: 'success' });
      return { source: 'playwright', layer: 'playwright+camoufox', markdown };
    }

    let html = result.html || '';

    // The browser path has no Content-Length to pre-screen (unlike the fetch layer), so cap the
    // rendered HTML here before the O(n) markdown conversion runs on it. Guards against a
    // pathological/hostile page ballooning worker + main-process memory.
    if (html.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(html.length / 1024 / 1024);
      logger.warn(`[Scrapers] Browser HTML too large (rendered: ${sizeMB}MB, max 25MB), skipping`);
      metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: 'html', layer: 'playwright' });
      throw new Error(`Browser HTML too large (${sizeMB}MB, max 25MB)`);
    }

    let markdown: string;
    try {
      markdown = await convertToMarkdown(html);
    } catch (e) {
      logger.error(`[Scrapers] Browser markdown conversion failed for ${_url}: ${String(e)}`);
      throw new Error(`Browser markdown conversion failed: ${String(e)}`, { cause: e });
    }
    
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

export async function scrapeSingle(url: string, signal?: AbortSignal, config?: Config, sessionId?: string, container: ServiceContainer = getServiceContainer()): Promise<ScrapeResult> {
  // Guard against an array accidentally stringified and passed as a single url (JSON arrays start
  // with '['). Do NOT reject brackets ANYWHERE: valid URLs legitimately contain them in query
  // strings (e.g. ?ids[]=1) and IPv6 literals (http://[::1]/) — the old includes('[') check dropped
  // those real sources before any fetch. A malformed non-URL string is still caught by the SSRF
  // validation below (new URL()).
  if (typeof url !== 'string' || url.trim().startsWith('[')) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url_format' });
    // Also record the once-per-URL terminal tally so this URL shows up as "failed" in the
    // run summary (urlsFailed derives from scrape_results_total{outcome:total_failure},
    // NOT scrape_errors_total). Every other terminal outcome emits this; these early
    // returns previously did not, so blocked/invalid URLs were invisible in the rollup.
    metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
    return { url, success: false, error: 'Invalid URL format (array passed as string?)', markdown: '' };
  }

  // FIX (New Issue A): Validate SSRF BEFORE any fetch attempt, so the blocked URL
  // cannot bypass validation through the stealth browser fallback path.
  try {
    await validateUrlForSSRF(url);
  } catch (ssrfError) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'ssrf_blocked' });
    // Once-per-URL terminal tally (see invalid_url_format above) so an SSRF-blocked URL
    // is counted as failed in the run summary rather than vanishing from URL accounting.
    metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
    errorTracker.trackError(ssrfError, {
      component: 'scrapers',
      operation: 'scrape',
      url,
      domain: extractDomain(url),
      layer: 'entry_point',
      errorType: 'ssrf_blocked',
    });
    return { url, success: false, error: String(ssrfError), markdown: '' };
  }
  
  const start = Date.now();
  try {
    const res = await scrapeWithFetch(url, signal);
    const duration = Date.now() - start;
    logger.log(`[Scrapers] fetch success for ${url} in ${duration}ms`);
    metrics.increment('scrape_results_total', 1, { outcome: 'fetch_success' });

    if (sessionId && res.markdown) {
      cacheScrapedContent(sessionId, url, res.markdown);
    }

    return { ...res, url, success: true };
  } catch (e1) {
    const fetchDuration = Date.now() - start;
    logger.debug(`[Scrapers] fetch failed for ${url} in ${fetchDuration}ms: ${String(e1)}`);
    // Not re-tracked here: scrapeWithFetch's own catch already recorded this error
    // with richer layer/errorType context immediately before rethrowing. Tracking
    // it again at this frame would double-count the same failure.

    if (playwrightAvailable) {
      try {
        const browserStart = Date.now();
        const res = await scrapeWithStealthBrowser(url, config, signal, sessionId, container);
        const browserDuration = Date.now() - browserStart;
        const totalDuration = Date.now() - start;
        logger.log(`[Scrapers] browser success for ${url} in ${browserDuration}ms (total: ${totalDuration}ms)`);
        metrics.increment('scrape_layer_fallbacks_total', 1, { from_layer: 'fetch', to_layer: 'playwright' });
        metrics.increment('scrape_results_total', 1, { outcome: 'browser_success' });

        if (sessionId && res.markdown) {
          cacheScrapedContent(sessionId, url, res.markdown);
        }

        return { ...res, url, success: true };
      } catch (e2) {
        const totalDuration = Date.now() - start;
        // A blocked/stubbed/HTTP-errored/slow/pool-draining URL is an expected
        // scraping outcome, already surfaced to the user as "not scraped" (the
        // total_failure metric below). Log it at debug so it neither pollutes the
        // ERROR log nor (via logger.error's re-track) inflates the diagnostic error
        // count. A genuine/unexpected fault (e.g. a markdown-conversion crash) stays
        // at ERROR with its stack. Either way, scrapeWithStealthBrowser's own catch
        // already tracked the error with layer context, so it is not re-tracked here.
        if (isBenignScrapeFailure(e2)) {
          logger.debug(`[Scrapers] Browser fallback did not yield content for ${url} in ${totalDuration}ms: ${String(e2)}`);
        } else {
          logger.error(`[Scrapers] Browser fallback failed for ${url} in ${totalDuration}ms:`, e2);
        }
        metrics.increment('scrape_errors_total', 1, { error_type: 'fallback_failed', layer: 'playwright' });
        metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
        return { url, success: false, error: String(e2), markdown: '' };
      }
    }
    metrics.increment('scrape_errors_total', 1, { error_type: 'no_fallback_available', layer: 'fetch' });
    metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
    return { url, success: false, error: String(e1), markdown: '' };
  }
}

export async function scrape(urls: string[], maxConcurrency = 5, signal?: AbortSignal, config?: Config, sessionId?: string, onUrlComplete?: (result: ScrapeResult) => void, container: ServiceContainer = getServiceContainer()): Promise<ScrapeResult[]> {
  metrics.increment('scrape_batches_total', 1);
  metrics.observe('scrape_urls_per_batch', urls.length);
  const batchStart = Date.now();
  
  const results: ScrapeResult[] = [];
  for (let i = 0; i < urls.length; i += maxConcurrency) {
    const batch = urls.slice(i, i + maxConcurrency);
    const batchRes = await Promise.all(
      batch.map(async url => {
        const result = await scrapeSingle(url, signal, config, sessionId, container);
        onUrlComplete?.(result);
        return result;
      })
    );
    results.push(...batchRes);
  }
  
  const batchDuration = Date.now() - batchStart;
  metrics.observe('scrape_batch_latency_ms', batchDuration);
  
  return results;
}

export function getDependencyStatus() {
  return { playwrightAvailable };
}
