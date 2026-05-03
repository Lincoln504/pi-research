/**
 * scrape Tool
 *
 * Scrape full content from URLs using a context-aware, up-to-2-call protocol.
 * Call 1 = Batch 1 (broad), Call 2 = Batch 2 (targeted).
 * After both batches are exhausted, the tool returns the limit-reached message.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { scrape } from '../web-research/scrapers.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { deduplicateUrls } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  MAX_SCRAPE_CALLS,
  BATCH_2_DEFAULT_CONCURRENCY,
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
  const MAX_CHARS_PER_URL = 10000; // ~2.5K tokens per URL

  const getContextFraction = (additionalTokens: number = 0): number => {

    if (!options.getTokensUsed) return 0;
    // Use scrape-specific tokens if tracked, otherwise total tokens
    const tokens = options.getScrapeTokens ? options.getScrapeTokens() : options.getTokensUsed();
    return (tokens + additionalTokens) / ctxWindow;
  };

  const getThreshold = () => options.getScrapeTokens ? MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING : MAX_CONTEXT_FRACTION_FOR_SCRAPING;

  const ScrapeParams = Type.Object({
    urls: Type.Array(Type.String(), { minItems: 1 }),
    maxConcurrency: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 20 })),
  });

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
      `PROTOCOL: Batch 1 → Batch 2 → Batch 3 (up to ${MAX_SCRAPE_URLS} URLs each).`,
      'Handshake is ELIMINATED. Start scraping immediately.',
      'Shared links from siblings are injected in real-time via steering.',
      'PDFs are auto-detected and extracted with high fidelity.',
      `Batches skipped automatically if context exceeds ${Math.round(getThreshold() * 100)}% — do not skip batches manually.`,
    ],
    parameters: ScrapeParams,
    async execute(_callId, params, signal): Promise<AgentToolResult<unknown>> {
      const callCount = options.tracker.getToolCallCount('scrape');
      const limit = options.tracker.getToolLimit('scrape') ?? MAX_SCRAPE_CALLS;
      if (callCount >= limit) {
          return {
            content: [{ type: 'text', text: options.tracker.getLimitMessage('scrape') }],
            details: { blocked: true, reason: 'limit_reached' },
          };
      }

      if (!Value.Check(ScrapeParams, params)) {
          return {
            content: [{ type: 'text', text: 'Invalid parameters for scrape tool. Expected an array of URLs.' }],
            details: { error: 'invalid_parameters' },
          };
      }

      const p = params as Static<typeof ScrapeParams>;
      let rawUrls = p.urls;
      
      // Sanitization: Handle LLM errors where it passes an array-like string
      // or a single string instead of an array (though typebox should catch latter)
      let urls: string[] = [];
      if (Array.isArray(rawUrls)) {
          rawUrls.forEach(u => {
              if (typeof u === 'string') {
                  // If the string contains [ ] or commas, it's likely a malformed array-as-string
                  if ((u.includes('[') || u.includes(']')) && u.includes(',')) {
                      const cleaned = u.replace(/[[]]/g, '').split(',').map(s => s.trim());
                      urls.push(...cleaned);
                  } else {
                      urls.push(u.trim());
                  }
              }
          });
      } else if (typeof rawUrls === 'string') {
          // Fallback for extreme LLM hallucination
          const s = rawUrls as string;
          urls = s.replace(/[[]]/g, '').split(',').map(u => u.trim());
      }
      
      // Deduplicate and filter out empty
      urls = Array.from(new Set(urls)).filter(u => u.startsWith('http'));

      if (urls.length === 0) {
          return { content: [{ type: 'text', text: 'No valid URLs provided for scraping.' }], details: { error: 'invalid_input' } };
      }

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
      const { kept: dedupedUrls, duplicates } = deduplicateUrls(urls, options.getGlobalState().researchId);
      let dedupNote = duplicates.length > 0 ? `**Global Deduplication**: ${duplicates.length} URL(s) skipped (already in pool).\n\n` : '';
      
      if (dedupedUrls.length === 0) {
          return { content: [{ type: 'text', text: `# ${batchLabel} Skipped\n\nAll URLs were already in the global pool.` }], details: { all_duplicates: true } };
      }

      const finalUrls = dedupedUrls.slice(0, MAX_SCRAPE_URLS);
      options.updateGlobalLinks(finalUrls);

      const defaultConcurrency = callCount >= 1 ? BATCH_2_DEFAULT_CONCURRENCY : 10;
      const scrapeResults = await scrape(finalUrls, p['maxConcurrency'] || defaultConcurrency, signal);
      const results = Array.isArray(scrapeResults) ? scrapeResults : [];
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);
      
      if (successful.length > 0 && options.onLinksScraped) {
          options.onLinksScraped(successful.map(r => r.url));
      }

      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${((Date.now() - startTime)/1000).toFixed(2)}s\n\n`;

      for (const res of successful) {
          let content = res.markdown || '';
          if (content.length > MAX_CHARS_PER_URL) {
              content = content.slice(0, MAX_CHARS_PER_URL) + '\n\n[...truncated - content too long for full analysis...]';
          }
          markdown += `### ${res.url}\n${content}\n\n---\n\n`;
      }
      
      return { content: [{ type: 'text', text: markdown }], details: { batch: callCount + 1, count: successful.length } };
    },
  };
}
