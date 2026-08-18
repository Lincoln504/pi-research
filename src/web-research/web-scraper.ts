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
import { getRandomUserAgent, extractDomain, validateUrlForSSRF, validateContent, createNativeMarkdownConverter, createJsMarkdownConverter, getSsrfSafeFetcher, formatErrorWithCause, isBenignScrapeFailure, isSsrfBlockError, } from './scraper-utils.ts';
import { isTransientError, abortableDelay } from './retry-utils.ts';
import { safeUnref } from '../utils/safe-unref.ts';
import { readBodyCapped, BodyTooLargeError } from '../utils/http-body.ts';
import { getServiceContainer } from '../core/service-registry.ts';
import type { ServiceContainer } from '../core/service-registry.ts';
import { cacheScrapedContent } from '../utils/shared-links.ts';

/** Backoff before the fetch layer's single transient retry. */
const FETCH_RETRY_DELAY_MS = 250;

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
    // THROW, never an in-band "*Error: ...*" string: a returned banner flowed
    // into validateContent as if it were page content, and a verbose one
    // (≥50 words / ≥200 chars) cleared the stub gate — the failure banner was
    // then cached and cited as a successful scrape.
    throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
  }

  const pdfExtractionStart = Date.now();

  // The native module load is caught SEPARATELY from the parse/extraction
  // logic below: a failure here (missing prebuilt binary for this platform,
  // corrupted install) is an INFRASTRUCTURE fault — PDF extraction is broken
  // for every URL, not just this one — not the routine, expected outcome of
  // a malformed/encrypted/scanned-image-only PDF. Sharing one catch with the
  // parse logic used to log both at `debug` and lump both under
  // 'extraction_failed', so a broken install produced an endless stream of
  // silent per-PDF "failures" instead of ever surfacing the real cause.
  let WasmPdfDocument: (new (bytes: Uint8Array) => {
    pageCount(): number;
    toMarkdownAll(): string;
    toMarkdown(page: number): string;
    free(): void;
  });
  try {
    ({ WasmPdfDocument } = await import('pdf-oxide-wasm'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[Scrapers] pdf-oxide-wasm failed to load — PDF extraction is unavailable (not just for this URL): ${msg}`);
    metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'native_module_unavailable' });
    errorTracker.trackError(e instanceof Error ? e : String(e), {
      component: 'scrapers',
      operation: 'pdf-extract',
      contentType: 'pdf',
      errorType: 'native_module_unavailable',
    });
    // Deliberately does NOT start with 'Could not extract content from PDF' —
    // isBenignScrapeFailure must NOT classify this as the routine per-PDF
    // outcome it is for the parse-failure branch below.
    throw new Error(`PDF extraction unavailable (pdf-oxide-wasm failed to load: ${msg})`, { cause: e });
  }

  try {
    const doc = new WasmPdfDocument(bytes);
    // free() is native/WASM-side memory, not GC-reclaimed — it must run on
    // every exit, including the case toMarkdownAll() AND the per-page fallback
    // both throw (a malformed/encrypted PDF the codebase already treats as
    // routine on the open web, so this path fires regularly). It used to sit
    // after the fallback loop, reachable only when nothing below it threw —
    // the one case that needed the fallback landing squarely on the one case
    // that skipped the free(), leaking one WasmPdfDocument per occurrence in a
    // browser-server process that stays warm across many research sessions.
    try {
      const pageCount = doc.pageCount();

      let markdown = `# PDF Document\n\n**Pages:** ${pageCount}\n\n`;

      try {
        markdown += doc.toMarkdownAll();
      } catch {
        for (let i = 0; i < pageCount; i++) {
          markdown += `## Page ${i + 1}\n\n${doc.toMarkdown(i)}\n\n`;
        }
      }

      const pdfExtractionDuration = Date.now() - pdfExtractionStart;
      metrics.observe('scrape_pdf_conversion_ms', pdfExtractionDuration);
      metrics.increment('scrape_pdf_conversions_total', 1, { status: 'success', pages: String(pageCount) });
      return markdown;
    } finally {
      doc.free();
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // debug, not error: a malformed/encrypted/scanned-image-only PDF is an
    // expected, non-actionable per-URL outcome, not a genuine fault — the same
    // reason isBenignScrapeFailure (scraper-utils.ts) keeps stub/blocked/HTTP-error
    // content out of ERROR. This is called from both the fetch layer (where a
    // browser-layer fallback always follows — the fetch layer's own catch at line
    // ~529 already logs ANY of its failures at debug for that reason) and the
    // browser layer (the last resort — isBenignScrapeFailure now recognizes this
    // message so that terminal call site's own classification stays consistent
    // too). Logging ERROR here, before either caller gets a chance to classify,
    // pre-empted both of those and always alarmed regardless.
    logger.debug(`[Scrapers] PDF extraction failed: ${msg}`);
    metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'extraction_failed' });
    errorTracker.trackError(e instanceof Error ? e : String(e), {
      component: 'scrapers',
      operation: 'pdf-extract',
      contentType: 'pdf',
      errorType: 'extraction_failed',
    });
    // See the size branch above: an extraction failure must FAIL the scrape,
    // not travel in-band as pseudo-content.
    throw new Error(`Could not extract content from PDF (${msg})`, { cause: e });
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

// readBodyCapped / BodyTooLargeError live in utils/http-body.ts — the scraper
// pioneered the streaming cap, and the JSON API clients now share that one
// implementation instead of each carrying a near-copy. The Content-Length
// pre-screen above stays advisory only: chunked responses carry no usable length
// header and the header is freely falsifiable, so the streamed cap is the check
// that actually bounds the allocation.

/**
 * Record a fetch-layer failure exactly once per URL.
 *
 * Kept out of {@link scrapeWithFetch} because that function is retried: tracking
 * inside it would file one transient failure as two, and the fetch layer's error
 * counts are precisely what production incidents are diagnosed from.
 */
function trackFetchLayerFailure(url: string, error: unknown): void {
  const isSsrf = isSsrfBlockError(error);
  errorTracker.trackError(error instanceof Error ? error : String(error), {
    component: 'scrapers',
    operation: 'fetch',
    url,
    domain: extractDomain(url),
    layer: 'fetch',
    ...(isSsrf ? { errorType: 'ssrf_blocked' } : {}),
  });
}

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  await validateUrlForSSRF(url);

  // Connect-time SSRF pin: the socket connects only to a validated public IP,
  // closing the DNS-rebinding TOCTOU gap between validateUrlForSSRF (request
  // time) and fetch's own re-resolution (connect time). Null when undici is
  // unavailable — request-time validation above still applies.
  //
  // The fetch implementation comes WITH the dispatcher and must be used with it:
  // a dispatcher is only honoured by the undici that built it, and the global
  // fetch is backed by Node's bundled undici, not ours. See getSsrfSafeFetcher.
  const fetcher = await getSsrfSafeFetcher();
  const doFetch = fetcher?.fetch ?? ((u: string, init: Record<string, unknown>) => fetch(u, init as RequestInit));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_LAYER_TIMEOUT);
  safeUnref(timeoutId);
  const onAbort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };
  if (signal) {
    // Honor a signal that is ALREADY aborted on entry — addEventListener alone never
    // fires for a pre-aborted signal, so a fetch dispatched after cancellation would
    // otherwise run to its full timeout instead of failing fast.
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const fetchStart = Date.now();
  try {
    // Manual redirect following so we can SSRF-validate each hop's Location header.
    // Using redirect:'follow' would bypass validateUrlForSSRF on 3xx targets.
    const MAX_REDIRECTS = 10;
    let currentUrl = url;
    let response!: Response;
    // One UA for the whole redirect chain. Picked per hop, a request could
    // present as Chrome on Windows and then as Firefox on macOS while following
    // a single Location chain — a browser never does that, so the rotation meant
    // to blend in was instead handing out a distinctive signal.
    const userAgent = getRandomUserAgent();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await doFetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
        },
        // Only ever attached alongside the fetch that honours it (see above).
        ...(fetcher ? { dispatcher: fetcher.dispatcher } : {}),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break; // No Location header — treat as final response
        const resolved = new URL(location, currentUrl).href;
        await validateUrlForSSRF(resolved); // Block SSRF targets in redirects
        // Drain the redirect response before following: an unconsumed body pins
        // its socket (undici keeps it open until read/cancelled or GC).
        try { await response.body?.cancel(); } catch { /* best-effort */ }
        currentUrl = resolved;
        continue;
      }
      break; // Non-redirect response
    }

    if (!response.ok) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'http_error', status_code: String(response.status) });
      // Same socket-pinning concern as the redirect drain above.
      try { await response.body?.cancel(); } catch { /* best-effort */ }
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
          // Same socket-pinning concern as the redirect/!ok drains above — and this
          // throw fires precisely on the LARGEST responses.
          try { await response.body?.cancel(); } catch { /* best-effort */ }
          throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`);
        }
      } else if (size > MAX_HTML_SIZE) {
        const sizeMB = Math.round(size / 1024 / 1024);
        logger.warn(`[Scrapers] HTML response too large (Content-Length: ${sizeMB}MB, max 25MB), skipping`);
        metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: contentType.split(';')[0] || 'unknown' });
        try { await response.body?.cancel(); } catch { /* best-effort */ }
        throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`);
      }
    }
    
    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      let pdfBytes: Uint8Array;
      try {
        pdfBytes = await readBodyCapped(response, MAX_PDF_SIZE);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          const sizeMB = Math.round(e.bytesRead / 1024 / 1024);
          logger.warn(`[Scrapers] PDF too large (streamed ${sizeMB}MB, max 100MB), skipping`);
          metrics.increment('scrape_pdf_errors_total', 1, { error_type: 'size_exceeded' });
          throw new Error(`PDF too large (${sizeMB}MB, max 100MB)`, { cause: e });
        }
        throw e;
      }
      const markdown = await extractPdfToMarkdown(pdfBytes);
      validateContent('', markdown, url);
      metrics.increment('scrape_operations_total', 1, { layer: 'fetch', content_type: 'pdf', status: 'success' });
      metrics.observe('scrape_latency_ms', fetchDuration, { layer: 'fetch', content_type: 'pdf', status: 'success' });
      return { source: 'fetch', layer: 'fetch', markdown };
    }

    // Read the raw bytes and decode with the DECLARED charset. response.text() blindly UTF-8-decodes,
    // which mangles Shift_JIS/GBK/EUC-KR/ISO-8859-1 pages into mojibake that then gets cached + cited.
    // Size-capped while streaming; the post-read check below is the belt for the
    // body-less fallback path inside readBodyCapped.
    let bodyBytes: Uint8Array;
    try {
      bodyBytes = await readBodyCapped(response, MAX_HTML_SIZE);
    } catch (e) {
      if (e instanceof BodyTooLargeError) {
        const sizeMB = Math.round(e.bytesRead / 1024 / 1024);
        logger.warn(`[Scrapers] HTML response too large (streamed ${sizeMB}MB, max 25MB), skipping`);
        metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: 'html' });
        // Not tracked here — scrapeSingle tracks the fetch layer's final error once.
        throw new Error(`HTML response too large (${sizeMB}MB, max 25MB)`, { cause: e });
      }
      throw e;
    }

    if (bodyBytes.length > MAX_HTML_SIZE) {
      const sizeMB = Math.round(bodyBytes.length / 1024 / 1024);
      logger.warn(`[Scrapers] HTML response too large (actual: ${sizeMB}MB, max 25MB), skipping`);
      metrics.increment('scrape_errors_total', 1, { error_type: 'size_exceeded', content_type: 'html' });
      // Not tracked here — scrapeSingle tracks the fetch layer's final error once.
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
    // Attempt-scoped metrics stay here (they count fetch operations, and a retried
    // attempt IS a second operation). Error TRACKING does not: scrapeSingle wraps this
    // call in a retry, and tracking per attempt would record one failure twice —
    // inflating exactly the error counts these numbers are read to diagnose.
    // scrapeSingle calls trackFetchLayerFailure once with the final error.
    if (isSsrfBlockError(error)) {
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

    // PDF bytes travel base64-encoded (bufferB64): the worker result crosses the
    // cluster-IPC JSON hop (and, for followers, a second JSON hop through the
    // leader's browser-server), which turns a raw Buffer into
    // {type:'Buffer',data:[...]} — new Uint8Array(that) is ZERO bytes, so the
    // extraction ran on nothing and its error string was cached as a "success".
    // The JSON-roundtripped legacy shape is still decoded so a mixed-version
    // leader/follower pair keeps working.
    const legacyBuffer = result.buffer;
    const pdfBytes: Buffer | null =
      typeof result.bufferB64 === 'string'
        ? Buffer.from(result.bufferB64, 'base64')
        : Array.isArray(legacyBuffer?.data)
          ? Buffer.from(legacyBuffer.data)
          : legacyBuffer instanceof Uint8Array
            ? Buffer.from(legacyBuffer)
            : null;

    if (pdfBytes !== null) {
      const markdown = await extractPdfToMarkdown(pdfBytes);
      // Mirror the fetch layer's PDF branch: extraction failures THROW from
      // extractPdfToMarkdown, and validateContent still fails a nominally
      // successful extraction that produced no real content — neither may be
      // recorded (and cached) as a success.
      validateContent('', markdown, _url);
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
    // A caller cancellation is not a scrape failure: no layer error metrics and
    // no tracker entry — the search path applies the same 'Aborted' special case
    // end-to-end (see browser-search.ts). scrapeSingle classifies it above us.
    if (signal?.aborted || (error instanceof Error && error.message === 'Aborted')) throw error;
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
  // Cancellation short-circuit: after a user abort each remaining URL would
  // otherwise still pay for SSRF DNS validation, a doomed fetch, and a browser
  // fallback — all logged/counted as failures the user never had. 'Aborted' is
  // the codebase's recognized cancellation signature (see browser-search.ts);
  // deliberately no total_failure tally, no tracker entry, no ERROR log.
  if (signal?.aborted) {
    return { url, success: false, error: 'Aborted', markdown: '' };
  }

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
    // One cheap transient retry before falling back to the (10–30× slower) stealth
    // browser. The fetch layer is the only scrape layer with no retry; a transient
    // socket/DNS blip (ECONNRESET, ENOTFOUND, UND_ERR_*, a bare `fetch failed`)
    // otherwise costs a full browser render. Gated on isTransientError, so SSRF
    // rejections, size caps and 4xx rethrow immediately; the outer catch still owns
    // the browser fallback on genuine exhaustion.
    //
    // Deliberately NOT retryWithBackoff: it logs every retry at WARN, and a
    // fetch-layer miss is an expected, benign event with a fallback behind it —
    // the same reason isBenignScrapeFailure keeps these out of ERROR. A burst of
    // blocked scrapes would otherwise emit one WARN per URL.
    const res = await (async () => {
      try {
        return await scrapeWithFetch(url, signal);
      } catch (firstErr) {
        if (!isTransientError(firstErr) || signal?.aborted) throw firstErr;
        logger.debug(`[Scrapers] fetch transient failure for ${url}, retrying once: ${formatErrorWithCause(firstErr)}`);
        metrics.increment('scrape_fetch_retries_total', 1, { layer: 'fetch' });
        try {
          // keepAlive: the retry is foreground work. An unref'd backoff is only safe
          // while some other handle is referenced; a lone scrape would otherwise let
          // the process exit during the 250ms gap and never make the second attempt.
          await abortableDelay(FETCH_RETRY_DELAY_MS, signal, true);
        } catch {
          throw firstErr; // aborted during backoff — surface the real cause
        }
        return await scrapeWithFetch(url, signal);
      }
    })();
    const duration = Date.now() - start;
    logger.log(`[Scrapers] fetch success for ${url} in ${duration}ms`);
    metrics.increment('scrape_results_total', 1, { outcome: 'fetch_success' });

    if (sessionId && res.markdown) {
      cacheScrapedContent(sessionId, url, res.markdown);
    }

    return { ...res, url, success: true };
  } catch (e1) {
    // Cancelled mid-fetch: not a fetch-layer failure, and no reason to pay for
    // the browser fallback — classify as the recognized cancellation (no ERROR
    // log, no tracker entry, no total_failure tally).
    if (signal?.aborted || (e1 instanceof Error && e1.message === 'Aborted')) {
      logger.debug(`[Scrapers] Scrape cancelled for ${url}`);
      return { url, success: false, error: 'Aborted', markdown: '' };
    }
    const fetchDuration = Date.now() - start;
    logger.debug(`[Scrapers] fetch failed for ${url} in ${fetchDuration}ms: ${formatErrorWithCause(e1)}`);
    // Tracked here rather than inside scrapeWithFetch, which is retried above —
    // one transient failure must file one error, not one per attempt.
    trackFetchLayerFailure(url, e1);

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
        // See the fetch-layer catch above: a cancellation surfacing from the
        // browser layer (runBrowserTask throws exactly 'Aborted' on a caller
        // abort) is not a failure — it must not reach the ERROR log, the error
        // tracker, or the total_failure tally.
        if (signal?.aborted || (e2 instanceof Error && e2.message === 'Aborted')) {
          logger.debug(`[Scrapers] Browser scrape cancelled for ${url}`);
          return { url, success: false, error: 'Aborted', markdown: '' };
        }
        const totalDuration = Date.now() - start;
        // A blocked/stubbed/HTTP-errored/slow/pool-draining URL is an expected
        // scraping outcome, already surfaced to the user as "not scraped" (the
        // total_failure metric below). Log it at debug so it neither pollutes the
        // ERROR log nor (via logger.error's re-track) inflates the diagnostic error
        // count. A genuine/unexpected fault (e.g. a markdown-conversion crash) stays
        // at ERROR with its stack. Either way, scrapeWithStealthBrowser's own catch
        // already tracked the error with layer context, so it is not re-tracked here.
        if (isBenignScrapeFailure(e2)) {
          logger.debug(`[Scrapers] Browser fallback did not yield content for ${url} in ${totalDuration}ms: ${formatErrorWithCause(e2)}`);
        } else {
          logger.error(`[Scrapers] Browser fallback failed for ${url} in ${totalDuration}ms:`, e2);
        }
        metrics.increment('scrape_errors_total', 1, { error_type: 'fallback_failed', layer: 'playwright' });
        metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
        return { url, success: false, error: formatErrorWithCause(e2), markdown: '' };
      }
    }
    metrics.increment('scrape_errors_total', 1, { error_type: 'no_fallback_available', layer: 'fetch' });
    metrics.increment('scrape_results_total', 1, { outcome: 'total_failure' });
    return { url, success: false, error: formatErrorWithCause(e1), markdown: '' };
  }
}

export async function scrape(urls: string[], maxConcurrency = 5, signal?: AbortSignal, config?: Config, sessionId?: string, onUrlComplete?: (result: ScrapeResult) => void, container: ServiceContainer = getServiceContainer()): Promise<ScrapeResult[]> {
  metrics.increment('scrape_batches_total', 1);
  metrics.observe('scrape_urls_per_batch', urls.length);
  const batchStart = Date.now();
  
  const results: ScrapeResult[] = [];
  for (let i = 0; i < urls.length; i += maxConcurrency) {
    // Stop dispatching once the caller has cancelled; URLs already in flight
    // settle via scrapeSingle's own cancellation classification. Without this,
    // every remaining batch still ran its full fetch + browser-fallback cycle
    // after a user cancel.
    if (signal?.aborted) {
      // scrapeSingle reports {success:false, error:'Aborted'} for a URL that
      // was already in flight when the signal fired — the sub-batches that
      // never even got dispatched (everything from here on) need the same
      // treatment. Without this, the caller's own results.length silently
      // fell short of urls.length with no indication a run was cut short —
      // the same "cancellation resolves through a normal, non-throwing path
      // and is invisible to the caller" gap the v1.3.1 research-tool fix
      // closed at the orchestrator level, recurring one layer down here.
      for (const url of urls.slice(i)) {
        const aborted: ScrapeResult = { url, success: false, error: 'Aborted', markdown: '' };
        onUrlComplete?.(aborted);
        results.push(aborted);
      }
      break;
    }
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
