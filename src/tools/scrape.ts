/**
 * scrape Tool
 *
 * Scrape full content from URLs using a context-aware, up-to-3-call protocol:
 *
 *   Call 1 (Batch 1)     – Scrape up to MAX_SCRAPE_URLS URLs; requires context < 55%.
 *   Call 2 (Batch 2)     – Scrape up to BATCH_2_MAX_SCRAPE_URLS URLs (targeted follow-up);
 *                          requires context < 55%; deduplicates against Batch 1.
 *   Call 3 (Batch 3)     – Scrape up to MAX_SCRAPE_URLS additional URLs; requires context < 55%.
 *   Call 4+ (Locked)     – All batches exhausted; move to synthesis.
 *
 * Context is measured as tokens_used / model_context_window.  When the threshold
 * is exceeded the tool returns an informative message instead of scraping, allowing
 * the researcher to proceed directly to synthesis with whatever it already has.
 *
 * Note: Global shared links (allScrapedLinks) are injected into the researcher's
 * system prompt at session creation time, eliminating the need for a handshake call.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { scrape, scrapeSingle } from '../web-research/scrapers.ts';
import { validateMaxConcurrency } from '../web-research/utils.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { deduplicateUrls } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_MAX_SCRAPE_URLS,
  BATCH_2_DEFAULT_CONCURRENCY,
  MAX_CONTEXT_FRACTION_FOR_SCRAPING,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  AVG_TOKENS_PER_SCRAPE,
} from '../constants.ts';

export function createScrapeTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
  /** Callback invoked when links are scraped (for real-time coordination) */
  onLinksScraped?: (links: string[]) => void;
  /** Returns tokens consumed by this researcher session so far. */
  getTokensUsed?: () => number;
  /** Model context window in tokens; defaults to DEFAULT_MODEL_CONTEXT_WINDOW. */
  contextWindowSize?: number;
}): ToolDefinition {

  // Helper to get globally scraped URLs for deduplication
  const getScrapedState = () => options.getGlobalState().allScrapedLinks || [];

  const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const getContextFraction = (additionalTokens: number = 0): number => {
    if (!options.getTokensUsed) return 0;
    return (options.getTokensUsed() + additionalTokens) / ctxWindow;
  };

  const contextLimitMessage = (fraction: number, batchLabel: string, projected: boolean = false): string => [
    `# Scrape Skipped — Context Budget ${projected ? 'Projection' : 'Reached'} (${batchLabel})`,
    '',
    `Your context window is currently **${Math.round((options.getTokensUsed?.() || 0) / ctxWindow * 100)}% full**.`,
    projected ? `Adding this scrape batch would push it to approximately **${Math.round(fraction * 100)}% full** ` +
      `(threshold: ${Math.round(MAX_CONTEXT_FRACTION_FOR_SCRAPING * 100)}%).` : 
      `This is at or above the threshold of **${Math.round(MAX_CONTEXT_FRACTION_FOR_SCRAPING * 100)}%**.`,
    'Scraping beyond this point risks truncating your findings during synthesis.',
    '',
    '**Action**: Proceed directly to **Phase 3 — Synthesis**.',
    'Compile your findings from Phase 1 (search results) and any earlier scrape batches,',
    'and submit your full report now.',
  ].join('\n');

  return {
    name: 'scrape',
    label: 'Scrape',
    description: 'Scrape content from URLs. Supports HTML and PDF (auto-detected). Context-aware 3-call protocol: batch 1 → batch 2 (targeted) → batch 3 (deep-dive).',
    promptSnippet: 'Scrape full content from URLs (context-aware protocol)',
    promptGuidelines: [
      'PROTOCOL: Up to 3 calls per researcher (batch 1 → batch 2 → batch 3).',
      'Batch 1 (max 3 URLs): Primary broad scraping.',
      'Batch 2 (max 2 URLs): Targeted follow-up. Auto-deduplicated.',
      'Batch 3 (max 3 URLs): Deep-dive on narrow sub-topic.',
      'Shared links from other researchers are in your system prompt — review before scraping.',
      'PDFs auto-detected and converted to Markdown. Note extraction failures in Research Process Notes.',
      `Batches skipped automatically if context exceeds ${Math.round(MAX_CONTEXT_FRACTION_FOR_SCRAPING * 100)}%. Move to synthesis.`,
      `Batch 2: max ${BATCH_2_MAX_SCRAPE_URLS} URLs with higher concurrency.`,
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String({
        description: 'URLs to scrape',
      }), { minItems: 1 }),
      maxConcurrency: Type.Optional(Type.Number({
        description: `Max parallel scrapes (default: 10 for batch 1/3, ${BATCH_2_DEFAULT_CONCURRENCY} for batch 2; capped at 20)`,
        default: 10,
        minimum: 1,
        maximum: 20,
      })),
      excludeLinks: Type.Optional(Type.Array(Type.String(), {
        description: 'Links you considered but are NOT scraping in this batch (Call 2/3/4 only). Helps track research decisions.',
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

      // ─── CALL 1: Batch 1 ──────────────────────────────────────────────────
      if (callCount === 0) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          // THROW to prevent researcher from calling again
          throw new Error('Scrape limit reached. All 3 batches completed.');
        }

        const paramsRecord = params as Record<string, unknown>;
        const urls = (paramsRecord['urls'] as string[] | undefined) || [];

        // Context gate (with projection)
        const projectedFraction = getContextFraction(urls.length * AVG_TOKENS_PER_SCRAPE);
        if (projectedFraction >= MAX_CONTEXT_FRACTION_FOR_SCRAPING) {
          return {
            content: [{ type: 'text', text: contextLimitMessage(projectedFraction, 'Batch 1', true) }],
            details: { skipped: true, reason: 'context_limit_projection', contextFraction: projectedFraction },
          };
        }

        const startTime = Date.now();
        const excludeLinks = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

        if (!Array.isArray(urls) || urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }
        if (urls.length > MAX_SCRAPE_URLS) {
          return {
            content: [{ type: 'text', text: `Error: Batch 1 limit is ${MAX_SCRAPE_URLS} URLs, but ${urls.length} were provided. Prioritize the most important ones.` }],
            details: { blocked: true },
          };
        }
        if (!Array.isArray(excludeLinks) || !excludeLinks.every(l => typeof l === 'string')) {
          throw new Error('excludeLinks must be an array of strings if provided.');
        }

        // Immediately update global link pool (signals intent to other researchers)
        // This ensures other researchers see these URLs as being scraped, even if
        // the fetch hasn't completed yet. Prevents duplicate scraping in concurrent scenarios.
        options.updateGlobalLinks(urls);

        let scrapeResults: any[];
        try {
          scrapeResults = urls.length === 1
            ? [await scrapeSingle(urls[0]!, signal)]
            : await scrape(urls, maxConcurrency, signal);
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

        // Emit link-scraped event for real-time coordination
        if (successful.length > 0 && options.onLinksScraped) {
          const scrapedUrls = successful.map((r: any) => r.url).filter((u: string) => u);
          if (scrapedUrls.length > 0) {
            try {
              options.onLinksScraped(scrapedUrls);
            } catch (err) {
              // Log error but don't fail the scrape operation
              console.error('[scrape] Failed to emit onLinksScraped callback:', err);
            }
          }
        }

        const ctxAfter = getContextFraction();
        const batch2Available = ctxAfter < MAX_CONTEXT_FRACTION_FOR_SCRAPING;

        let markdown = `# URL Scrape Results (Batch 1 of up to 3)\n\n`;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;

        if (excludeLinks.length > 0) {
          markdown += `**Links considered but not scraped:**\n${excludeLinks.map(l => `- ${l}`).join('\n')}\n\n`;
        }

        if (batch2Available) {
          markdown += `**Batch 2 available** (max ${BATCH_2_MAX_SCRAPE_URLS} URLs, targeted follow-up). **Batch 3 available** (max ${MAX_SCRAPE_URLS} URLs, deep-dive). Context ${Math.round(ctxAfter * 100)}% full.\n`;
        } else {
          markdown += `⚠️ **Context ${Math.round(ctxAfter * 100)}% full** — Batch 2 will be skipped. Proceed to synthesis after reviewing these results.\n`;
        }
        markdown += '\n';

        for (const result of successful) {
          const category = result.sourceCategory ? `**Source type**: ${result.sourceCategory}\n` : '';
          markdown += `### ${result.url}\n${category}\n${result.markdown}\n\n---\n\n`;
        }
        if (failed.length > 0) {
          markdown += `### Failed URLs\n${failed.map((r: any) => `- ${r.url}`).join('\n')}\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, excludeLinks, successfulCount: successful.length, duration: elapsed, batch: 1 },
        };
      }

      // ─── CALL 2: Batch 2 ──────────────────────────────────────────────────
      if (callCount === 1) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          // THROW to prevent researcher from calling again
          throw new Error('Scrape limit reached. All 3 batches completed.');
        }

        const paramsRecord = params as Record<string, unknown>;
        let urls = (paramsRecord['urls'] as string[] | undefined) || [];

        // Context gate (with projection)
        const projectedFraction = getContextFraction(urls.length * AVG_TOKENS_PER_SCRAPE);
        if (projectedFraction >= MAX_CONTEXT_FRACTION_FOR_SCRAPING) {
          return {
            content: [{ type: 'text', text: contextLimitMessage(projectedFraction, 'Batch 2', true) }],
            details: { skipped: true, reason: 'context_limit_projection', contextFraction: projectedFraction },
          };
        }

        const startTime = Date.now();
        const rawExclude = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        // Batch 2 uses higher default concurrency
        const maxConcurrency = validateMaxConcurrency(
          (paramsRecord['maxConcurrency'] as number | undefined) ?? BATCH_2_DEFAULT_CONCURRENCY
        );

        if (!Array.isArray(urls) || urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // Deduplicate against globally scraped URLs (includes all previous batches)
        const { kept: dedupedUrls, duplicates: globalDuplicates } = deduplicateUrls(urls, getScrapedState());
        
        // Report duplicates to the AI
        let dedupNote = '';
        const deduped = globalDuplicates.length;
        if (deduped > 0) {
          dedupNote = `**Global Deduplication**: ${deduped} URL(s) were already in the global scraped pool.\n\n`;
        }
        urls = dedupedUrls;

        if (urls.length === 0) {
          return {
            content: [{ type: 'text', text: `# Batch 2 Skipped\n\nAll URLs were already scraped in previous batches or globally. Proceed to synthesis.` }],
            details: { skipped: true, reason: 'all_duplicates' },
          };
        }

        if (urls.length > BATCH_2_MAX_SCRAPE_URLS) {
          urls = urls.slice(0, BATCH_2_MAX_SCRAPE_URLS);
        }

        // Immediately update global link pool (signals intent to other researchers)
        // This ensures other researchers see these URLs as being scraped, even if
        // the fetch hasn't completed yet. Prevents duplicate scraping in concurrent scenarios.
        options.updateGlobalLinks(urls);

        let scrapeResults: any[];
        try {
          scrapeResults = urls.length === 1
            ? [await scrapeSingle(urls[0]!, signal)]
            : await scrape(urls, maxConcurrency, signal);
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

        // Emit link-scraped event for real-time coordination
        if (successful.length > 0 && options.onLinksScraped) {
          const scrapedUrls = successful.map((r: any) => r.url).filter((u: string) => u);
          if (scrapedUrls.length > 0) {
            try {
              options.onLinksScraped(scrapedUrls);
            } catch (err) {
              // Log error but don't fail the scrape operation
              console.error('[scrape] Failed to emit onLinksScraped callback:', err);
            }
          }
        }

        const ctxAfter = getContextFraction();
        const batch3Available = ctxAfter < MAX_CONTEXT_FRACTION_FOR_SCRAPING;

        let markdown = `# URL Scrape Results (Batch 2)\n\n`;
        if (dedupNote) markdown += dedupNote;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s`;


        if (rawExclude.length > 0) {
          markdown += `**Links considered but not scraped:**\n${rawExclude.map(l => `- ${l}`).join('\n')}\n\n`;
        }

        if (batch3Available) {
          markdown += `**Batch 3 available** (context ${Math.round(ctxAfter * 100)}% full). Up to ${MAX_SCRAPE_URLS} more URLs for deep-dive.\n\n`;
        } else {
          markdown += `**All standard batches complete** (context ${Math.round(ctxAfter * 100)}% full). Proceed to Phase 3 — Synthesis.\n\n`;
        }

        for (const result of successful) {
          const category = result.sourceCategory ? `**Source type**: ${result.sourceCategory}\n` : '';
          markdown += `### ${result.url}\n${category}\n${result.markdown}\n\n---\n\n`;
        }
        if (failed.length > 0) {
          markdown += `### Failed URLs\n${failed.map((r: any) => `- ${r.url}`).join('\n')}\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, excludeLinks: rawExclude, successfulCount: successful.length, duration: elapsed, batch: 2 },
        };
      }

      // ─── CALL 3: Batch 3 (context-gated deep-dive) ───────────────────────
      if (callCount === 2) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          // THROW to prevent researcher from calling again
          throw new Error('Scrape limit reached. All 3 batches completed.');
        }

        const paramsRecord = params as Record<string, unknown>;
        let urls = (paramsRecord['urls'] as string[] | undefined) || [];

        // Context gate (with projection)
        const projectedFraction = getContextFraction(urls.length * AVG_TOKENS_PER_SCRAPE);
        if (projectedFraction >= MAX_CONTEXT_FRACTION_FOR_SCRAPING) {
          return {
            content: [{ type: 'text', text: contextLimitMessage(projectedFraction, 'Batch 3', true) }],
            details: { skipped: true, reason: 'context_limit_projection', contextFraction: projectedFraction },
          };
        }

        const startTime = Date.now();
        const rawExclude = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

        if (!Array.isArray(urls) || urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // Deduplicate against globally scraped URLs (includes all previous batches)
        const { kept: dedupedUrls, duplicates: globalDuplicates } = deduplicateUrls(urls, getScrapedState());
        
        // Report duplicates to the AI
        let dedupNote = '';
        if (globalDuplicates.length > 0) {
          dedupNote = `**Global Deduplication**: ${globalDuplicates.length} URL(s) were already in the global scraped pool.\n\n`;
        }
        urls = dedupedUrls;

        if (urls.length === 0) {
          return {
            content: [{ type: 'text', text: `# Batch 3 Skipped\n\nAll URLs were already scraped in previous batches or globally. Proceed to synthesis.` }],
            details: { skipped: true, reason: 'all_duplicates' },
          };
        }

        if (urls.length > MAX_SCRAPE_URLS) {
          urls = urls.slice(0, MAX_SCRAPE_URLS);
        }

        // Immediately update global link pool (signals intent to other researchers)
        // This ensures other researchers see these URLs as being scraped, even if
        // the fetch hasn't completed yet. Prevents duplicate scraping in concurrent scenarios.
        options.updateGlobalLinks(urls);

        let scrapeResults: any[];
        try {
          scrapeResults = urls.length === 1
            ? [await scrapeSingle(urls[0]!, signal)]
            : await scrape(urls, maxConcurrency, signal);
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

        // Emit link-scraped event for real-time coordination
        if (successful.length > 0 && options.onLinksScraped) {
          const scrapedUrls = successful.map((r: any) => r.url).filter((u: string) => u);
          if (scrapedUrls.length > 0) {
            try {
              options.onLinksScraped(scrapedUrls);
            } catch (err) {
              // Log error but don't fail the scrape operation
              console.error('[scrape] Failed to emit onLinksScraped callback:', err);
            }
          }
        }

        let markdown = `# URL Scrape Results (Batch 3 — Deep-Dive)\n\n`;
        if (dedupNote) markdown += dedupNote;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;
        markdown += `**All scrape batches complete.** Proceed to Phase 3 — Synthesis.\n\n`;

        if (rawExclude.length > 0) {
          markdown += `**Links considered but not scraped:**\n${rawExclude.map(l => `- ${l}`).join('\n')}\n\n`;
        }

        for (const result of successful) {
          const category = result.sourceCategory ? `**Source type**: ${result.sourceCategory}\n` : '';
          markdown += `### ${result.url}\n${category}\n${result.markdown}\n\n---\n\n`;
        }
        if (failed.length > 0) {
          markdown += `### Failed URLs\n${failed.map((r: any) => `- ${r.url}`).join('\n')}\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { urls, excludeLinks: rawExclude, successfulCount: successful.length, duration: elapsed, batch: 3 },
        };
      }

      // ─── CALL 4+: Locked ──────────────────────────────────────────────────
      return {
        content: [{ type: 'text', text: 'Locked: All scrape batches have been used. Proceed directly to Phase 3 — Synthesis.' }],
        details: { locked: true },
      };
    },
  };
}
