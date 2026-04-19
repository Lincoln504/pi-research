/**
 * Web Research Extension - Scrapers
 *
 * 2-layer scraping architecture:
 * Layer 1: fetch (Node built-in, concurrent, no browser overhead)
 * Layer 2: Playwright + Chromium (standard headless, for JS-heavy sites)
 *
 * Native HTML-to-Markdown conversion is preferred when available because it
 * offers the best filtering control. On macOS, the upstream native package is
 * currently published without the actual binary artifact, so we lazily fall
 * back to a pure-JS converter instead of failing module load.
 */

import {
  PRIMARY_SCRAPER_TIMEOUT,
  FALLBACK_SCRAPER_TIMEOUT,
  type ScrapeLayerResult,
} from './types.ts';
import {
  trackContext,
  untrackContextById,
  clearTrackedContexts,
  checkModule,
} from './utils.ts';
import { logger } from '../logger.ts';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ============================================================================
// Type Definitions
// ============================================================================

// AbortSignal.any() and AbortSignal.timeout() are Node.js 20+ features

// Playwright types (since module is optional/dynamically loaded)
interface LaunchOptions {
  headless: boolean;
  args: string[];
}

interface Browser {
  isConnected(): boolean;
  close(): Promise<void>;
   
  newContext(options?: { viewport: unknown }): Promise<BrowserContext>;
}

interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

interface Page {
   
  goto(url: string, options: { waitUntil: string; timeout: number }): Promise<void>;
  content(): Promise<string>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
     
    launch(options: LaunchOptions): Promise<Browser>;
  };
}

import { shutdownManager } from '../utils/shutdown-manager.ts';

// ============================================================================
// Module State
// ============================================================================

let playwrightAvailable: boolean = false;
let markdownConverterPromise: Promise<(html: string) => Promise<string>> | null = null;

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
let scraperDependenciesInitialized = false;

export function initScraperDependencies(): void {
  if (scraperDependenciesInitialized) {
    return;
  }

  scraperDependenciesInitialized = true;
  playwrightAvailable = checkModule('playwright');
  shutdownManager.register(stopChromium);
}

initScraperDependencies();

// ============================================================================
// Chromium singleton browser
//
// One Chromium process is shared across all scrape calls for the lifetime of
// the session. Playwright manages the child process; each scrape opens its own
// isolated BrowserContext+Page and closes them when done — the browser itself
// stays alive. This eliminates the ~1-2s Chromium startup cost per tool call.
//
// Lifecycle:
//   - Lazily started on first Layer 2 scrape attempt
//   - stopChromium() is registered with the extension cleanup registry
//   - pi triggers that cleanup from session_shutdown
//   - On /reload, the old browser var is reset to null; the old Chromium process
//     is an orphan but Playwright registers an on-exit handler that kills it when
//     the Node process exits — acceptable bounded leak for the /reload case
// ============================================================================

let sharedBrowser: Browser | null = null;
let sharedBrowserLaunchPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  // Return existing connected browser
  if (sharedBrowser?.isConnected()) {
    return Promise.resolve(sharedBrowser);
  }

  // Coalesce concurrent launch requests into one Promise
  if (sharedBrowserLaunchPromise !== null) {
    return sharedBrowserLaunchPromise;
  }

  if (sharedBrowser !== null) {
    // Browser existed but lost connection — relaunch
    logger.log('[Scrapers] Chromium disconnected, relaunching...');
    sharedBrowser = null;
  } else {
    logger.log('[Scrapers] Launching Chromium...');
  }

  sharedBrowserLaunchPromise = (async (): Promise<Browser> => {
    try {
      const playwright = require('playwright') as PlaywrightModule;
      sharedBrowser = await playwright.chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      logger.log('[Scrapers] Chromium launched');
      return sharedBrowser;
    } finally {
      // Always clear the promise — success or failure — so the next call
      // retries the launch rather than returning a permanently cached rejection.
      sharedBrowserLaunchPromise = null;
    }
  })();

  return sharedBrowserLaunchPromise;
}

export async function stopChromium(): Promise<void> {
  const b = sharedBrowser;
  const p = sharedBrowserLaunchPromise;

  if (b === null && p === null) {
    return; // Nothing to stop
  }

  logger.log('[Scrapers] Stopping Chromium...');

  // Capture and null both references before any await so concurrent calls
  // cannot double-close.
  sharedBrowser = null;
  sharedBrowserLaunchPromise = null;

  // Clear all tracked contexts since they become invalid when browser closes
  // This prevents memory leaks and stale references
  clearTrackedContexts();

  if (b !== null) {
    await b.close().catch(() => {});
  } else if (p !== null) {
    // A launch was in-progress; wait for it, then close what it produced.
    const launched = await p.catch(() => null);
    if (launched !== null) {
      await launched.close().catch(() => {});
    }
  }

  logger.log('[Scrapers] Chromium stopped');
}

/**
 * Convert HTML to Markdown using visitor pattern for element-level filtering
 * Removes: images (including base64 SVG), iframes, nav, header, footer, aside, form, script, style, object, embed
 * Preserves: main content, headings, paragraphs, lists, code blocks, tables, links
 *
 * Uses @kreuzberg/html-to-markdown-node with proper JSON handling for visitor callbacks.
 * The native NAPI bindings expect callbacks with signature: (jsonString: string) => Promise<string>
 */
async function convertToMarkdown(html: string): Promise<string> {
  const converter = await getMarkdownConverter();
  return converter(html);
}

async function getMarkdownConverter(): Promise<(html: string) => Promise<string>> {
  if (markdownConverterPromise !== null) {
    return markdownConverterPromise;
  }

  markdownConverterPromise = (async () => {
    try {
      const nativeModule = await import('@kreuzberg/html-to-markdown-node') as NativeHtmlToMarkdownModule;
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
  // Visitor object for element-level filtering
  // Each method receives JSON context string and must return JSON result string
  const visitor = {
    /**
     * Skip all images (including base64-encoded SVG, PNG, etc.)
     * Primary source of noise in web-scraped content
     */
     
    async visitImage(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    /**
     * Skip links that point to image data URIs (SVG, PNG, etc.)
     * These appear as [text](data:image/svg+xml;base64,...) in markdown output
     */
     
    async visitLink(ctxJson?: string): Promise<string> {
      const parsed = JSON.parse(ctxJson ?? '{}') as { href?: string };
      const href = parsed.href;
      if (href !== undefined && (
        href.startsWith('data:image/svg+xml') ||
        href.startsWith('data:image/png') ||
        href.startsWith('data:image/jpeg') ||
        href.startsWith('data:image/gif') ||
        href.startsWith('data:image/webp') ||
        href.startsWith('data:image/') ||
        href.match(/\.(svg|png|jpg|jpeg|gif|webp|bmp|ico)$/i) !== null
      )) {
        return JSON.stringify({ type: 'skip' });
      }
      return JSON.stringify({ type: 'continue' });
    },

    /**
     * Skip all iframes (embedded content, videos, ads)
     */
     
    async visitIframe(): Promise<string> {
      return JSON.stringify({ type: 'skip' });
    },

    /**
     * Filter structural elements before processing their content
     * Removes navigation, headers, footers, sidebars, and other boilerplate
     * CRITICAL: Also filters inline <svg> elements which are converted to base64 images by html-to-markdown
     * visitImage callback is NOT triggered for inline <svg> elements
     */
     
    async visitElementStart(ctxJson?: string): Promise<string> {
      // Parse JSON context string to object
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
    textReplace: [
      [/\u00a0/g, ' '],
    ],
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
// Fetch content quality validation
//
// fetch() succeeds on pages that are HTTP 200 but contain no useful content:
// bot-detection challenges, JS-required stubs, login redirects, or empty shells.
// These must fail fast so the URL falls through to Chromium rather than
// returning garbage markdown to the caller.
//
// Checks (in order):
//   1. Structural bot/challenge fingerprints in raw HTML — machine-generated
//      CDN markers that cannot appear in legitimate content
//   2. Markdown word count < MIN_WORD_COUNT — the primary gate; catches
//      challenge pages, JS stubs, and login redirects with zero maintenance
// ============================================================================

// Minimum word count after HTML→markdown conversion.
// Challenge pages, JS stubs, and login redirects produce almost nothing after
// our visitor strips nav/header/footer/script/style. Real content pages have
// hundreds to thousands of words. 100 catches most bad pages while being
// lenient enough for short API docs and brief documentation pages.
const MIN_WORD_COUNT = 100;

// Domain-specific minimum word counts for known trusted sources.
// These domains are known to produce legitimate content even with fewer words.
// For example, Wikipedia summaries, API docs, and technical references often
// have concise but valuable content.
const DOMAIN_THRESHOLDS: Readonly<Record<string, number>> = {
  'wikipedia.org': 30,
  'en.wikipedia.org': 30,
  'docs.python.org': 40,
  'developer.mozilla.org': 40,
  'example.com': 20, // For testing purposes
  'httpbin.org': 20, // Testing endpoints
};

// Helper: Extract hostname from URL and check for domain-specific threshold
function getDomainThreshold(url: string): number {
  try {
    const urlObj = new globalThis.URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Check for exact match or subdomain match
    for (const [domain, threshold] of Object.entries(DOMAIN_THRESHOLDS)) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        logger.log(`[Scrapers] Using domain threshold ${threshold} for ${hostname}`);
        return threshold;
      }
    }
  } catch {
    // Invalid URL, use default
  }
  return MIN_WORD_COUNT;
}

// Machine-generated structural fingerprints only — these are CDN/service
// infrastructure markers that cannot appear in legitimate page content and
// are stable across service updates. No human-readable text patterns here
// (false positive risk, English-only, covered by word count anyway).
const BOT_PATTERNS: ReadonlyArray<[string, string]> = [
  ['_cf_chl_', 'Cloudflare challenge'],
  ['cdn-cgi/challenge-platform', 'Cloudflare challenge platform'],
  ['ddos-guard', 'DDoS-Guard challenge'],
];

function validateContent(html: string, markdown: string, url: string): void {
  // 1. Structural bot/challenge fingerprints in raw HTML
  const htmlLow = html.toLowerCase();
  for (const [pattern, reason] of BOT_PATTERNS) {
    if (htmlLow.includes(pattern)) {
      throw new Error(`Fetch blocked: ${reason} — page requires a real browser`);
    }
  }

  // 2. Content too thin after markdown conversion — catches JS stubs, challenge
  //    pages, login redirects, and any other page that renders little real content
  const words = markdown.trim().split(/\s+/).filter(w => w.length > 0);
  const threshold = getDomainThreshold(url);
  if (words.length < threshold) {
    throw new Error(`Fetch returned stub: only ${words.length} words in markdown (min ${threshold} for this domain) — likely JS-rendered or gated`);
  }
}

/**
 * Layer 1: fetch (Node built-in)
 *
 * Fast, concurrent, zero browser overhead. Works for any static or server-rendered
 * HTML page. Falls through to Chromium for JS-heavy or gated pages.
 *
 * Concurrency: each call is an independent async HTTP request on the event loop.
 * No per-connection state is shared, so many can run in parallel safely.
 *
 * Timeout: uses AbortSignal.any() to combine the caller's abort signal with a
 * per-request timeout, so cancellation is immediate regardless of which fires first.
 */

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  // Helper function to create timeout signal with Node.js compatibility
  const createTimeoutSignal = (timeoutMs: number): AbortSignal => {
    if (typeof AbortSignal.timeout === 'function') {
      // Node.js 20+
      return AbortSignal.timeout(timeoutMs);
    } else {
      // Fallback for older Node.js versions
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      // Ensure timeout is cleared if signal is aborted externally
      if (signal !== undefined) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeoutId);
        }, { once: true });
      }
      // Unref so it doesn't keep the process alive
      if (typeof timeoutId.unref === 'function') {
        timeoutId.unref();
      }
      return controller.signal;
    }
  };

  const timeoutSignal = createTimeoutSignal(PRIMARY_SCRAPER_TIMEOUT);
  const fetchSignal = signal !== undefined && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: fetchSignal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } catch (error) {
    // Handle network errors, DNS failures, connection refused, etc.
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new Error(`Fetch timeout: ${error.message}`, { cause: error });
      }
      throw new Error(`Network error: ${error.message}`, { cause: error });
    }
    throw new Error(`Network error: ${String(error)}`, { cause: error });
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    throw new Error(`Non-HTML content-type: ${contentType}`);
  }

  const html = await response.text();
  let markdown: string;
  try {
    markdown = await convertToMarkdown(html);
  } catch (error) {
    throw new Error(`HTML-to-markdown conversion failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  validateContent(html, markdown, url);

  return { source: 'fetch', layer: 'fetch', markdown };
}


/**
 * Layer 2: Playwright + Chromium (shared singleton browser)
 *
 * Uses the module-level shared Chromium browser. Opens an isolated
 * BrowserContext+Page, closes them when done, but leaves the browser running.
 */

async function scrapeWithChromium(_url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  if (signal?.aborted) {
    // Create an abort error using standard Error with the correct name
    const error = new Error('Aborted') as Error & { name: string; cause?: unknown };
    error.name = 'AbortError';
    error.cause = signal;
    throw error;
  }

  const browser = await getBrowser();

  // Re-check after the async browser acquisition — signal may have fired during launch
  if (signal?.aborted) {
    const error = new Error('Aborted') as Error & { name: string; cause?: unknown };
    error.name = 'AbortError';
    error.cause = signal;
    throw error;
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let contextId: string | null = null;
  let abortListener: (() => void) | null = null;

  if (signal !== undefined) {
    abortListener = (): void => {
      // Close page then context to release browser resources on abort.
      // Both may be null if abort fires before or during their creation.
      if (page !== null) {
        page.close().catch(() => {});
      }
      if (context !== null) {
        context.close().catch(() => {});
      }
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    context = await browser.newContext({ viewport: null });
    page = await context.newPage();

    contextId = trackContext(browser, context, page);

    await page.goto(_url, { waitUntil: 'domcontentloaded', timeout: FALLBACK_SCRAPER_TIMEOUT });

    const html = await page.content();
    let markdown: string;
    try {
      markdown = await convertToMarkdown(html);
    } catch (error) {
      throw new Error(`HTML-to-markdown conversion failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    // Validate content quality — bot-challenge pages served to a real browser
    // (cookie consent walls, DDoS-Guard JS challenges) still produce garbage
    // markdown; better to surface an error than silently return a stub.
    validateContent(html, markdown, _url);

    return {
      source: 'playwright',
      layer: 'playwright+chromium',
      markdown,
    };
  } finally {
    // Remove abort listener if it was added and never fired
    // Note: With { once: true }, the listener auto-removes when it fires
    if (signal !== undefined && abortListener !== null) {
      try {
        signal.removeEventListener('abort', abortListener);
      } catch {
        // Listener might have already fired and auto-removed
      }
    }

    if (contextId !== null) {
      untrackContextById(contextId);
    }

    // Close page and context if they exist
    if (page !== null) {
      await page.close().catch(() => {});
    }
    if (context !== null) {
      await context.close().catch(() => {});
    }
    // browser is intentionally NOT closed here
  }

}

interface ScrapeUrlResult {
  url: string;
  source: string;
  layer?: string;
  markdown: string;
  error?: string;
  sourceCategory?: string;
}

/**
 * Classify a URL into a human-readable source category.
 *
 * Categories (in priority order):
 *   github-pr, github-issue, github-discussion, github-repo
 *   official-docs  — docs.* hostnames or /docs/ /reference/ /api/ /guide/ /manual/ paths
 *   release-notes  — changelog / release paths or hostnames
 *   forum-community — Reddit, Stack Overflow, HN, community.* subdomains, /forum/ /questions/ paths
 *   vendor-blog    — blog.* hostnames or /blog/ paths
 *   web            — fallback
 */
export function classifySourceCategory(url: string): string {
  try {
    const parsed = new globalThis.URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    // GitHub — check specific path patterns before the generic repo catch-all
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      if (/\/pull\/\d+/.test(path))         return 'github-pr';
      if (/\/issues\/\d+/.test(path))       return 'github-issue';
      if (/\/discussions\/\d+/.test(path))  return 'github-discussion';
      return 'github-repo';
    }

    // Official documentation — hostname prefix or well-known path segments
    if (
      hostname.startsWith('docs.') ||
      hostname.startsWith('developer.') ||
      /\/(docs|reference|api|guide|guides|manual|documentation)(\/|$)/.test(path)
    ) {
      return 'official-docs';
    }

    // Release notes / changelogs
    if (
      /\/(releases?|changelog|changelogs|release-notes|whatsnew|what-s-new)(\/|$)/.test(path) ||
      /changelog|release-notes/.test(hostname)
    ) {
      return 'release-notes';
    }

    // Forum / community sources
    if (
      hostname === 'reddit.com' || hostname.endsWith('.reddit.com') ||
      hostname === 'stackoverflow.com' || hostname.endsWith('.stackoverflow.com') ||
      hostname === 'stackexchange.com' || hostname.endsWith('.stackexchange.com') ||
      hostname === 'news.ycombinator.com' ||
      hostname === 'lobste.rs' ||
      hostname.startsWith('community.') ||
      hostname.startsWith('forum.') ||
      /\/(forum|forums|questions|q\/|community)(\/|$)/.test(path)
    ) {
      return 'forum-community';
    }

    // Vendor / personal blogs
    if (hostname.startsWith('blog.') || /\/blog(\/|$)/.test(path)) {
      return 'vendor-blog';
    }

    return 'web';
  } catch {
    return 'web';
  }
}

function assertSafeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP(S) URL: ${rawUrl}`);
  }

  const host = parsed.hostname.toLowerCase();

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.')) {
    throw new Error(`Blocked loopback URL: ${rawUrl}`);
  }

  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === 'metadata.internal') {
    throw new Error(`Blocked cloud metadata URL: ${rawUrl}`);
  }

  if (host.endsWith('.local')) {
    throw new Error(`Blocked .local hostname: ${rawUrl}`);
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = parseInt(ipv4[1]!, 10);
    const b = parseInt(ipv4[2]!, 10);
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      throw new Error(`Blocked private/link-local URL: ${rawUrl}`);
    }
  }
}

/**
 * Single URL scraping with 2-layer sequential fallback
 */

export async function scrapeSingle(url: string, signal?: AbortSignal): Promise<ScrapeUrlResult> {
  try {
    assertSafeUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, source: 'failed', markdown: '', error: msg, sourceCategory: 'web' };
  }

  const errors: Array<{ layer: string; error: string; errorType: string }> = [];

  const sourceCategory = classifySourceCategory(url);

  // Layer 1: fetch (fast, no browser overhead)
  try {
    const result = await scrapeWithFetch(url, signal);
    return { url, source: result.source, layer: result.layer, markdown: result.markdown, sourceCategory };
  } catch (error1) {
    const errorInfo = extractErrorInfo(error1);
    errors.push({ layer: 'fetch', error: errorInfo.message, errorType: errorInfo.type });
  }

  // Layer 2: Playwright + Chromium (shared singleton browser)
  if (signal?.aborted) {
    return { url, source: 'cancelled', markdown: '', error: 'Cancelled before Layer 2', sourceCategory };
  }
  if (playwrightAvailable) {
    try {
      const result = await scrapeWithChromium(url, signal);
      return { url, source: result.source, layer: result.layer, markdown: result.markdown, sourceCategory };
    } catch (error2) {
      const errorInfo = extractErrorInfo(error2);
      errors.push({ layer: 'Playwright+Chromium', error: errorInfo.message, errorType: errorInfo.type });
    }
  }

  return {
    url,
    source: 'failed',
    markdown: '',
    error: `All layers failed: ${errors.map(e => `${e.layer}: ${e.error} [${e.errorType}]`).join('; ')}`,
    sourceCategory,
  };

}

interface LayerResult {
  url: string;
  success: boolean;
  markdown?: string;
  source?: string;
  layer?: string;
  error?: string;
  errorType?: string;
}

interface ExtractedErrorInfo {
  message: string;
  name: string;
  type: string;
}

/**
 * Extract error information for better debugging
 */
function extractErrorInfo(error: unknown): ExtractedErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      type: error.constructor.name,
    };
  }
  return {
    message: String(error),
    name: 'Unknown',
    type: typeof error,
  };
}

/**
 * Scrape multiple URLs in a single layer with concurrency control
 */

async function scrapeUrlsInLayer(
  urls: string[],
  maxConcurrency: number,
   
  scraperFn: (url: string, _signal?: AbortSignal) => Promise<ScrapeLayerResult>,
  signal?: AbortSignal,
): Promise<LayerResult[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += maxConcurrency) {
    chunks.push(urls.slice(i, i + maxConcurrency));
  }

  const allResults: LayerResult[] = [];

  for (const chunk of chunks) {
    if (signal?.aborted) {
      break;
    }

    const promises = chunk.map((url) =>
      scraperFn(url, signal)
        .then((result) => ({ url, success: true, markdown: result.markdown, source: result.source, layer: result.layer }))
         
        .catch((error: Error) => {
          const errorInfo = extractErrorInfo(error);
          return {
            url,
            success: false,
            error: `${errorInfo.name}: ${errorInfo.message}`,
            errorType: errorInfo.type,
          };
        }),
    );

    const chunkResults = await Promise.all(promises);
    allResults.push(...chunkResults);
  }

  return allResults;

}


/**
 * Bulk scraping with 2-layer simultaneous processing
 */

export async function scrape(urls: string[], maxConcurrency = 10, signal?: AbortSignal): Promise<ScrapeUrlResult[]> {

  const results = new Map<string, ScrapeUrlResult>();
  const errors = new Map<string, Array<{ layer: string; error: string; errorType?: string }>>();
  let failedUrls: string[] = [...urls];
  let aborted = false;

  // Layer 1: fetch — concurrent, no browser overhead
  const layer1Results = await scrapeUrlsInLayer(failedUrls, maxConcurrency, scrapeWithFetch, signal);

  layer1Results.forEach(result => {
    if (result.success && result.layer !== undefined) {
      results.set(result.url, {
        url: result.url,
        source: result.source ?? 'fetch',
        layer: result.layer,
        markdown: result.markdown ?? '',
        sourceCategory: classifySourceCategory(result.url),
      });
    } else if (!result.success) {
      const urlErrors = errors.get(result.url) ?? [];
      urlErrors.push({ layer: 'fetch', error: result.error ?? 'Unknown error', errorType: result.errorType ?? 'Error' });
      errors.set(result.url, urlErrors);
    }
  });

  failedUrls = layer1Results.filter(r => !r.success).map(r => r.url);
  if (signal?.aborted) {
    aborted = true;
  }

  // Layer 2: Playwright + Chromium (persistent singleton browser)
  if (!aborted && playwrightAvailable && failedUrls.length > 0) {
    const layer2Results = await scrapeUrlsInLayer(failedUrls, maxConcurrency, scrapeWithChromium, signal);

    layer2Results.forEach(result => {
      if (result.success && result.layer !== undefined) {
        results.set(result.url, {
          url: result.url,
          source: result.source ?? 'playwright',
          layer: result.layer,
          markdown: result.markdown ?? '',
          sourceCategory: classifySourceCategory(result.url),
        });
      } else if (!result.success) {
        const urlErrors = errors.get(result.url) ?? [];
        urlErrors.push({ layer: 'Playwright+Chromium', error: result.error ?? 'Unknown error', errorType: result.errorType ?? 'Error' });
        errors.set(result.url, urlErrors);
      }
    });

    failedUrls = layer2Results.filter(r => !r.success).map(r => r.url);
  }

  const finalResults: ScrapeUrlResult[] = Array.from(results.values());

  failedUrls.forEach(url => {
    const urlErrors = errors.get(url) ?? [];
    const errorSummary = urlErrors.map(e => `${e.layer}: ${e.error} [${e.errorType ?? 'Error'}]`).join('; ');
    finalResults.push({
      url,
      source: 'failed',
      markdown: '',
      error: `All layers failed: ${errorSummary}`,
    });
  });

  return finalResults;
}

export interface DependencyStatus {
  readonly playwrightAvailable: boolean;
}

export function getDependencyStatus(): DependencyStatus {
  return { playwrightAvailable };
}
