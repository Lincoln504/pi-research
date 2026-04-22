/**
 * scrape Tool
 *
 * Scrape full content from URLs using a context-aware, up-to-3-call protocol.
 * Optimized for real-time link sharing and handshake elimination.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { scrape } from '../web-research/scrapers.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { deduplicateUrls } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_MAX_SCRAPE_URLS,
  MAX_CONTEXT_FRACTION_FOR_SCRAPING,
  MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  AVG_TOKENS_PER_SCRAPE,
} from '../constants.ts';

export function createScrapeTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
  onLinksScraped?: (links: string[]) => void;
  getTokensUsed?: () => number;
  getScrapeTokens?: () => number;
  contextWindowSize?: number;
}): ToolDefinition {

  const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  
  const getContextFraction = (additionalTokens: number = 0): number => {
    if (!options.getTokensUsed) return 0;
    // Use scrape-specific tokens if tracked, otherwise total tokens
    const tokens = options.getScrapeTokens ? options.getScrapeTokens() : options.getTokensUsed();
    return (tokens + additionalTokens) / ctxWindow;
  };

  const getThreshold = () => options.getScrapeTokens ? MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING : MAX_CONTEXT_FRACTION_FOR_SCRAPING;

  const contextLimitMessage = (fraction: number, batchLabel: string, projected: boolean = false): string => [
    `# Scrape Skipped — Context Budget ${projected ? 'Projection' : 'Reached'} (${batchLabel})`,
    '',
    `Your research context is currently **${Math.round(fraction * 100)}% full** (threshold: ${Math.round(getThreshold() * 100)}%).`,
    'Scraping beyond this point risks truncating your findings during synthesis.',
    '',
    '**Action**: Proceed directly to **Phase 3 — Synthesis**.',
    'Compile your findings from search results and any earlier scrape batches, and submit your full report now.',
  ].join('\n');

  return {
    name: 'scrape',
    label: 'Scrape',
    description: 'Scrape content from URLs. Supports HTML and PDF. Protocol: Batch 1 → Batch 2 → Batch 3.',
    promptSnippet: 'Scrape full content from URLs (3-batch protocol)',
    promptGuidelines: [
      'PROTOCOL: Batch 1 (3 URLs) → Batch 2 (2 URLs) → Batch 3 (3 URLs).',
      'Handshake is ELIMINATED. Start scraping immediately.',
      'Shared links from siblings are injected in real-time via steering.',
      'PDFs are auto-detected and extracted with high fidelity.',
      `Batches skipped if real research data exceeds ${Math.round(getThreshold() * 100)}% of context.`,
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { minItems: 1 }),
      maxConcurrency: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 20 })),
    }),
    async execute(_callId, params, signal): Promise<AgentToolResult<unknown>> {
      const callCount = options.tracker.getCallCount('scrape');
      if (callCount >= 3) {
          throw new Error('SCRAPE LIMIT REACHED. All 3 batches completed. Proceed to synthesis.');
      }

      const p = params as Record<string, any>;
      const urls = p['urls'] as string[];
      const batchLabel = `Batch ${callCount + 1}`;

      // Context Gate
      const projectedFraction = getContextFraction(urls.length * AVG_TOKENS_PER_SCRAPE);
      if (projectedFraction >= getThreshold()) {
        return {
          content: [{ type: 'text', text: contextLimitMessage(projectedFraction, batchLabel, true) }],
          details: { skipped: true, reason: 'context_limit' },
        };
      }

      options.tracker.recordCall('scrape');
      const startTime = Date.now();
      
      // Global Deduplication
      const { kept: dedupedUrls, duplicates } = deduplicateUrls(urls, options.getGlobalState().rootQuery);
      let dedupNote = duplicates.length > 0 ? `**Global Deduplication**: ${duplicates.length} URL(s) skipped (already in pool).\n\n` : '';
      
      if (dedupedUrls.length === 0) {
          return { content: [{ type: 'text', text: `# ${batchLabel} Skipped\n\nAll URLs were already in the global pool.` }], details: { all_duplicates: true } };
      }

      const finalUrls = dedupedUrls.slice(0, callCount === 1 ? BATCH_2_MAX_SCRAPE_URLS : MAX_SCRAPE_URLS);
      options.updateGlobalLinks(finalUrls);

      const scrapeResults = await scrape(finalUrls, p['maxConcurrency'] || 10, signal);
      const results = Array.isArray(scrapeResults) ? scrapeResults : [];
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      if (successful.length > 0 && options.onLinksScraped) {
          options.onLinksScraped(successful.map(r => r.url));
      }

      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${((Date.now() - startTime)/1000).toFixed(2)}s\n\n`;

      for (const res of successful) {
          markdown += `### ${res.url}\n${res.markdown}\n\n---\n\n`;
      }
      
      return { content: [{ type: 'text', text: markdown }], details: { batch: callCount + 1, count: successful.length } };
    },
  };
}
