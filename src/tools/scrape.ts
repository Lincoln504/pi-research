/**
 * scrape Tool
 *
 * Scrape full content from one or more URLs using 2-layer architecture.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { scrape, scrapeSingle } from '../web-research/scrapers.js';
import { validateMaxConcurrency } from '../web-research/utils.js';

interface ScrapeParams {
  urls: string[];
  maxConcurrency?: number;
  [key: string]: unknown;
}

export function createScrapeTool(_options: {
  searxngUrl: string;
  ctx: ExtensionContext;
}): ToolDefinition {

  return {
    name: 'scrape',
    label: 'Scrape',
    description: 'Scrape full content from one or more URLs using 2-layer architecture: fetch (fast, concurrent) → Playwright+Chromium (JS-heavy fallback). Returns markdown content.',
    promptSnippet: 'Scrape full content from URLs (returns full markdown)',
    promptGuidelines: [
      'Use scrape to get full content from specific URLs.',
      'Uses 2-layer scraping: fetch first, then Playwright for JS-heavy pages.',
      'Set maxConcurrency for bulk scraping (default: 10 parallel requests).',
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({
        description: 'URLs to scrape - one or more',
      }), { minItems: 1 }),
      maxConcurrency: Type.Optional(Type.Number({
        description: 'Max parallel scrapes (default: 10)',
        default: 10,
        minimum: 1,
        maximum: 20,
      })),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      _extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      const paramsRecord = params as Record<string, unknown>;

      if (!isScrapeParams(paramsRecord)) {
        throw new Error('Invalid parameters for scrape');
      }

      const urls = paramsRecord['urls'] as string[];
      if (urls.length === 0) {
        throw new Error('At least one URL is required');
      }

      const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

      let scrapeResults: Array<{ url: string; source: string; layer?: string; markdown: string; error?: string }>;
      try {
        if (urls.length === 1) {
          const url = urls[0];
          if (url === undefined) {
            throw new Error('URL is undefined');
          }
          scrapeResults = [await scrapeSingle(url, signal)];
        } else {
          scrapeResults = await scrape(urls, maxConcurrency, signal);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const elapsed = Date.now() - startTime;
        return {
          content: [
            {
              type: 'text',
              text: `# URL Scrape Failed\n\n**Error:** ${errorMsg}\n\n**URLs Attempted:** ${urls.length}\n\n**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\nFailed to scrape the requested URLs. The error may be due to network issues, timeouts, or unavailable pages.`,
            },
          ],
          details: {
            urls,
            error: errorMsg,
            duration: elapsed,
          },
        };
      }

      const elapsed = Date.now() - startTime;

      const successful = scrapeResults.filter(r => r.source !== 'failed');
      const failed = scrapeResults.filter(r => r.source === 'failed');

      let markdown = '# URL Scrape Results\n\n';
      markdown += `**URLs Processed:** ${urls.length}\n`;
      markdown += `**Concurrency:** ${maxConcurrency}\n`;
      markdown += `**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
      markdown += `**Successful:** ${successful.length}\n`;
      markdown += `**Failed:** ${failed.length}\n\n`;

      if (successful.length > 0) {
        markdown += '## Successful Scrapes\n\n';
        for (const result of successful) {
          markdown += `### ${result.url}\n\n`;
          const layer = result.layer ?? 'unknown';
          markdown += `- **Layer:** ${layer}\n`;
          markdown += `- **Characters:** ${result.markdown.length}\n`;
          markdown += '\n---\n\n';
          markdown += result.markdown;
          markdown += '\n\n---\n\n';
        }
      }

      if (failed.length > 0) {
        markdown += '## Failed Scrapes\n\n';
        markdown += '| URL | Error |\n';
        markdown += '|-----|-------|\n';
        for (const result of failed) {
          const error = result.error ?? 'Unknown error';
          markdown += `| ${result.url} | ${error} |\n`;
        }
        markdown += '\n';
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: {
          urls,
          maxConcurrency,
          successfulCount: successful.length,
          failedCount: failed.length,
          duration: elapsed,
        },
      };
    },
  };
}

function isScrapeParams(params: Record<string, unknown>): params is ScrapeParams {
  return (
    typeof params === 'object' &&
    params !== null &&
    'urls' in params &&
    Array.isArray(params['urls']) &&
    (params['urls'] as unknown[]).every((u: unknown) => typeof u === 'string')
  );
}
