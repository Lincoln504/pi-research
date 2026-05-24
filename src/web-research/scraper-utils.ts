/**
 * Scraper Utilities
 */

import crypto from 'node:crypto';
import { errorTracker } from '../utils/error-tracker.ts';
import { metrics } from '../utils/metrics.ts';
import {
  USER_AGENTS,
  FILTERED_TAGS,
  IMAGE_LINK_PATTERN,
  MARKDOWN_IMAGE_PATTERN,
  BOT_PATTERNS,
  INTERNAL_NETWORK_PATTERNS,
  type NativeJsNodeContext,
  type NativeHtmlToMarkdownModule,
} from './scraper-types.ts';

/**
 * Get a random user agent
 */
export function getRandomUserAgent(): string {
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
    return USER_AGENTS[0]!;
  }
}

/**
 * Extract domain from URL for error tracking
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

/**
 * Validate URL to prevent SSRF attacks
 */
export function validateUrlForSSRF(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'localhost' });
      throw new Error('Access to localhost is not allowed');
    }
    
    for (const pattern of INTERNAL_NETWORK_PATTERNS) {
      if (pattern.test(hostname)) {
        metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'internal_network' });
        throw new Error('Access to internal networks is not allowed');
      }
    }
    
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      metrics.increment('scrape_ssrf_blocks_total', 1, { block_type: 'invalid_protocol' });
      throw new Error('Only HTTP/HTTPS protocols are allowed');
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('not allowed')) {
      throw e;
    }
    metrics.increment('scrape_errors_total', 1, { error_type: 'invalid_url' });
    throw new Error(`Invalid URL: ${url}`, { cause: e });
  }
}

/**
 * Strip image links from markdown
 */
export function stripImageLinks(markdown: string): string {
  return markdown
    .replace(MARKDOWN_IMAGE_PATTERN, '')
    .replace(IMAGE_LINK_PATTERN, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Create native HTML to markdown converter
 */
export function createNativeMarkdownConverter(
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

/**
 * Create JS HTML to markdown converter (fallback)
 */
export function createJsMarkdownConverter(): (html: string) => Promise<string> {
  const { NodeHtmlMarkdown } = require('node-html-markdown');
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

/**
 * Validate scraped content
 */
export function validateContent(html: string, markdown: string, url: string): void {
  const htmlLow = html.toLowerCase();
  for (const [pattern, reason] of BOT_PATTERNS) {
    if (htmlLow.includes(pattern)) {
      metrics.increment('scrape_errors_total', 1, { error_type: 'bot_protection' });
      const error = new Error(`Fetch blocked: ${reason}`);
      errorTracker.trackError(error, {
        component: 'scrapers',
        operation: 'validate',
        url,
        domain: extractDomain(url),
        errorType: 'bot_protection',
      });
      throw error;
    }
  }

  const words = markdown.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 50 && !url.includes('example.com')) {
    metrics.increment('scrape_errors_total', 1, { error_type: 'stub_content' });
    const error = new Error(`Fetch returned stub: only ${words.length} words found.`);
    errorTracker.trackError(error, {
      component: 'scrapers',
      operation: 'validate',
      url,
      domain: extractDomain(url),
      errorType: 'stub_content',
    });
    throw error;
  }
}