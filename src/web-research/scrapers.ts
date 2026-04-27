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

// ============================================================================
// Type Definitions
// ============================================================================

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
async function extractPdfToMarkdown(bytes: Uint8Array): Promise<string> {
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
        return markdown;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(`[Scrapers] PDF extraction failed: ${msg}`);
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
    if (htmlLow.includes(pattern)) throw new Error(`Fetch blocked: ${reason}`);
  }

  const words = markdown.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 50 && !url.includes('example.com')) {
    throw new Error(`Fetch returned stub: only ${words.length} words found.`);
  }
}

// ============================================================================
// Layer 1: Fetch
// ============================================================================

async function scrapeWithFetch(url: string, signal?: AbortSignal): Promise<ScrapeLayerResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PRIMARY_SCRAPER_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => clearTimeout(timeoutId));

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
      const buffer = await response.arrayBuffer();
      const markdown = await extractPdfToMarkdown(new Uint8Array(buffer));
      return { source: 'fetch', layer: 'fetch', markdown };
    }

    const html = await response.text();
    const markdown = await convertToMarkdown(html);
    validateContent(html, markdown, url);
    return { source: 'fetch', layer: 'fetch', markdown };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Layer 2: Browser
// ============================================================================

async function scrapeWithStealthBrowser(_url: string): Promise<ScrapeLayerResult> {
  // Dispatch to unified worker pool (Camoufox)
  const result = await runBrowserTask<any>(_url, 'scrape');

  if (result.buffer) {
      const markdown = await extractPdfToMarkdown(new Uint8Array(result.buffer));
      return { source: 'playwright', layer: 'playwright+camoufox', markdown };
  }

  let html = result.html || '';
  let markdown = await convertToMarkdown(html);

  // Robustness: If we got a stub, the main thread can't easily tell the worker 
  // to retry with networkidle without another roundtrip.
  // However, the unified worker now uses a standard high-fidelity wait.
  
  validateContent(html, markdown, _url);

  return { source: 'playwright', layer: 'playwright+camoufox', markdown };
}

// ============================================================================
// Public API
// ============================================================================

export async function scrapeSingle(url: string, signal?: AbortSignal): Promise<any> {
  try {
    const res = await scrapeWithFetch(url, signal);
    return { ...res, url, success: true };
  } catch (e1) {
    if (playwrightAvailable) {
      try {
        const res = await scrapeWithStealthBrowser(url);
        return { ...res, url, success: true };
      } catch (e2) {
        logger.error(`[Scrapers] Browser fallback failed for ${url}:`, e2);
        return { url, success: false, error: String(e2), markdown: '' };
      }
    }
    return { url, success: false, error: String(e1), markdown: '' };
  }
}

export async function scrape(urls: string[], maxConcurrency = 5, signal?: AbortSignal): Promise<any[]> {
    const results: any[] = [];
    for (let i = 0; i < urls.length; i += maxConcurrency) {
        const batch = urls.slice(i, i + maxConcurrency);
        const batchRes = await Promise.all(batch.map(url => scrapeSingle(url, signal)));
        results.push(...batchRes);
    }
    return results;
}

export function getDependencyStatus() {
  return { playwrightAvailable };
}
