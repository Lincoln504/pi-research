/**
 * scrape Tool
 *
 * Scrape full content from one or more URLs using 2-layer architecture.
 * Implements a state-aware protocol:
 * 1. First call: Returns a list of all links already scraped in the global session.
 * 2. Second call: Performs the actual scraping and updates the global link pool.
 * 3. Third call+: Locked out.
 *
 * Batch size is limited to MAX_BATCH_SIZE URLs per scrape pass to manage context window.
 */

/** Maximum number of URLs that can be scraped in a single batch. */
const MAX_BATCH_SIZE = 4;

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { scrape, scrapeSingle } from '../web-research/scrapers.ts';
import { validateMaxConcurrency } from '../web-research/utils.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/swarm-types.ts';

export function createScrapeTool(options: {
  searxngUrl: string;
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
}): ToolDefinition {

  return {
    name: 'scrape',
    label: 'Scrape',
    description: 'Scrape content from URLs. This tool follows a protocol: First call returns previously scraped links; second call performs the scrape.',
    promptSnippet: 'Scrape full content from URLs (state-aware protocol)',
    promptGuidelines: [
      'PROTOCOL: This tool must be called TWICE to scrape.',
      'CALL 1: Provide your intended URLs. The tool will return a list of links already scraped by other researchers.',
      'REVIEW: Compare your list with the returned list. Remove any duplicates.',
      'CALL 2: Provide your FINAL filtered list of URLs to perform the actual scraping.',
      'CRITICAL: You only get ONE actual scraping execution. Use it wisely.',
      `BATCH LIMIT: You can scrape a maximum of ${MAX_BATCH_SIZE} URLs per batch. If you have more links, prioritize the most important ones.`,
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({
        description: `URLs to scrape (max ${MAX_BATCH_SIZE} per batch)`,
      }), { minItems: 1 }),
      maxConcurrency: Type.Optional(Type.Number({
        description: 'Max parallel scrapes (default: 10)',
        default: 10,
        minimum: 1,
        maximum: 20,
      })),
      excludeLinks: Type.Optional(Type.Array(Type.String(), {
        description: 'Links you have decided to skip based on Call 1 info',
      })),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      _extensionCtx,
    ): Promise<AgentToolResult<unknown>> {
      const callCount = options.tracker.getCallCount('scrape');
      const state = options.getGlobalState();

      // --- CALL 1: Handshake (Info Only) ---
      if (callCount === 0) {
        options.tracker.recordCall('scrape'); // Move to count 1
        return {
          content: [{ 
            type: 'text', 
            text: [
              '# Scrape Protocol: Call 1 (Handshake)',
              'You have requested to scrape URLs. To avoid redundancy, here are all links already scraped in this research session:',
              '',
              state.allScrapedLinks && state.allScrapedLinks.length > 0 
                ? state.allScrapedLinks.map(l => `- ${l}`).join('\n')
                : '*No links have been scraped yet.*',
              '',
              '**Action Required:**',
              '1. Review the list above.',
              '2. Remove any of these links from your intended scrape list.',
              '3. Call the `scrape` tool again with your FINAL filtered list to proceed with scraping.',
              `Note: You can scrape at most ${MAX_BATCH_SIZE} URLs per batch. If you have more links, prioritize the most important ones.`
            ].join('\n')
          }],
          details: { protocol: 'handshake', previouslyScrapedCount: state.allScrapedLinks?.length || 0 },
        };
      }

      // --- CALL 2: Execution ---
      if (callCount === 1) {
        const allowed = options.tracker.recordCall('scrape'); // Move to count 2
        if (!allowed) {
           return { content: [{ type: 'text', text: 'Error: Scrape limit reached.' }], details: { blocked: true } };
        }

        const startTime = Date.now();
        const paramsRecord = params as Record<string, unknown>;
        const urls = (paramsRecord['urls'] as string[] | undefined) || [];
        const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

        if (urls.length > MAX_BATCH_SIZE) {
          return { content: [{ type: 'text', text: `Error: Batch size limit exceeded. You can scrape at most ${MAX_BATCH_SIZE} URLs per batch, but provided ${urls.length}. Please prioritize the most important URLs.` }], details: { blocked: true } };
        }

        if (urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // IMMEDIATELY update global link pool before starting the actual scrape
        // This ensures Sibling B sees Sibling A's intent immediately
        options.updateGlobalLinks(urls);

        let scrapeResults: any[];
        try {
          if (urls.length === 1) {
            const url = urls[0]!;
            scrapeResults = [await scrapeSingle(url, signal)];
          } else {
            scrapeResults = await scrape(urls, maxConcurrency, signal);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text', text: `# Scrape Failed\n\n${errorMsg}` }],
            details: { error: errorMsg },
          };
        }

        const successful = scrapeResults.filter(r => r.source !== 'failed');
        const failed = scrapeResults.filter(r => r.source === 'failed');
        const elapsed = Date.now() - startTime;

        let markdown = `# URL Scrape Results\n\n**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
        for (const result of successful) {
          markdown += `### ${result.url}\n\n${result.markdown}\n\n---\n\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, successfulCount: successful.length, duration: elapsed },
        };
      }

      // --- CALL 3+: Locked ---
      return {
        content: [{ type: 'text', text: 'Locked: You have already performed your one allowed scrape for this session. Proceed to synthesis.' }],
        details: { locked: true },
      };
    },
  };
}
