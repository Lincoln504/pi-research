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
const MAX_BATCH_SIZE = 3;

/** Maximum number of scrape calls allowed per researcher. */
const MAX_SCRAPE_CALLS = 3;

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
    description: 'Scrape content from URLs. This tool follows a protocol: First call returns previously scraped links; second and third calls perform scraping in up to two batches.',
    promptSnippet: 'Scrape full content from URLs (state-aware protocol)',
    promptGuidelines: [
      'PROTOCOL: This tool must be called THREE times to complete scraping.',
      'CALL 1 (Handshake): Provide your intended URLs. The tool will return a list of links already scraped by other researchers.',
      'REVIEW: Compare your list with the returned list. Remove any duplicates.',
      'CALL 2 (First Batch): Provide your filtered list of URLs (max 3) to perform the first scraping batch.',
      'CALL 3 (Second Batch): After reviewing results from Call 2, you may provide additional URLs (max 3) for a second scraping batch.',
      `BATCH LIMIT: You can scrape a maximum of ${MAX_BATCH_SIZE} URLs per batch. If you have more links, prioritize the most important ones.`,
      'USE CASES FOR SECOND BATCH: 1) Different links for different information, 2) Retry failed scrapes, 3) Follow-up on incomplete findings.',
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
        description: 'Links you considered but are NOT scraping in this batch (Call 2/3 only). Helps track research decisions.',
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
              '**Protocol Overview:**',
              `1. You have ${MAX_SCRAPE_CALLS - 1} scrape batches available (max ${MAX_BATCH_SIZE} URLs each).`,
              '2. First batch (Call 2): Scrape your highest priority URLs.',
              '3. Second batch (Call 3): After reviewing results, you can scrape additional URLs for different information, retry failed scrapes, or follow up on incomplete findings.',
              '',
              '**Action Required:**',
              '1. Review the scraped links list above.',
              '2. Remove any duplicates from your intended scrape list.',
              '3. Call the `scrape` tool again with your filtered list (max 3 URLs) to begin the first batch.',
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
        const excludeLinks = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

        if (urls.length > MAX_BATCH_SIZE) {
          return { content: [{ type: 'text', text: `Error: Batch size limit exceeded. You can scrape at most ${MAX_BATCH_SIZE} URLs per batch, but provided ${urls.length}. Please prioritize the most important URLs.` }], details: { blocked: true } };
        }

        if (urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // Validate excludeLinks
        if (!Array.isArray(excludeLinks) || !excludeLinks.every(l => typeof l === 'string')) {
          throw new Error('excludeLinks must be an array of strings if provided.');
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

        let markdown = `# URL Scrape Results (Batch 1 of 2)\n\n**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
        
        if (excludeLinks.length > 0) {
          markdown += `**Links considered but not scraped:**\n${excludeLinks.map(l => `- ${l}`).join('\n')}\n\n`;
        }
        
        markdown += `**Note:** You have one more batch available (Call 3). Use it for:\n`;
        markdown += `1. Different links for different information\n`;
        markdown += `2. Retry failed scrapes from this batch\n`;
        markdown += `3. Follow-up on incomplete findings\n\n`;
        
        for (const result of successful) {
          markdown += `### ${result.url}\n\n${result.markdown}\n\n---\n\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, excludeLinks, successfulCount: successful.length, duration: elapsed, batch: 1 },
        };
      }

      // --- CALL 3: Second Batch ---
      if (callCount === 2) {
        const allowed = options.tracker.recordCall('scrape');
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

        // Update global link pool with new scraped URLs
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

        let markdown = `# URL Scrape Results (Batch 2 of 2)\n\n**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
        
        markdown += `**All scrape batches complete.** You have no more scrape calls remaining.\n`;
        markdown += `Proceed to Phase 3: synthesize your findings and submit your report.\n\n`;
        
        for (const result of successful) {
          markdown += `### ${result.url}\n\n${result.markdown}\n\n---\n\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, successfulCount: successful.length, duration: elapsed, batch: 2 },
        };
      }

      // --- CALL 4+: Locked ---
      return {
        content: [{ type: 'text', text: 'Locked: You have already completed both scrape batches. Proceed to synthesis.' }],
        details: { locked: true },
      };
    },
  };
}
