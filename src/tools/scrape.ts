/**
 * scrape Tool
 *
 * Scrape full content from URLs using a context-aware, up-to-4-call protocol:
 *
 *   Call 1  (Handshake)  – Return already-scraped links; no network activity.
 *   Call 2  (Batch 1)    – Scrape up to MAX_SCRAPE_URLS URLs; requires context < 50 %.
 *   Call 3  (Batch 2)    – Scrape up to BATCH_2_MAX_SCRAPE_URLS URLs (targeted follow-up);
 *                          requires context < 50 %; deduplicates against Batch 1.
 *   Call 4  (Batch 3)    – Optional deep-dive; only runs when context < 40 %.
 *                          Scrape up to MAX_SCRAPE_URLS additional URLs.
 *   Call 5+ (Locked)     – All batches exhausted; move to synthesis.
 *
 * Context is measured as tokens_used / model_context_window.  When the threshold
 * is exceeded the tool returns an informative message instead of scraping, allowing
 * the researcher to proceed directly to synthesis with whatever it already has.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { scrape, scrapeSingle } from '../web-research/scrapers.ts';
import { validateMaxConcurrency } from '../web-research/utils.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_MAX_SCRAPE_URLS,
  BATCH_2_DEFAULT_CONCURRENCY,
  MAX_CONTEXT_FRACTION_FOR_SCRAPING,
  MAX_CONTEXT_FRACTION_FOR_BATCH3,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from '../constants.ts';

export function createScrapeTool(options: {
  searxngUrl: string;
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
  /** Returns tokens consumed by this researcher session so far. */
  getTokensUsed?: () => number;
  /** Model context window in tokens; defaults to DEFAULT_MODEL_CONTEXT_WINDOW. */
  contextWindowSize?: number;
}): ToolDefinition {

  // Per-instance state: track what was scraped in batch 1 so batch 2/3 can deduplicate
  let batch1Urls: string[] = [];
  let batch2Urls: string[] = [];

  const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  const getContextFraction = (): number => {
    if (!options.getTokensUsed) return 0;
    return options.getTokensUsed() / ctxWindow;
  };

  const contextLimitMessage = (fraction: number, batchLabel: string): string => [
    `# Scrape Skipped — Context Budget Reached (${batchLabel})`,
    '',
    `Your context window is approximately **${Math.round(fraction * 100)}% full** ` +
      `(threshold: ${Math.round(MAX_CONTEXT_FRACTION_FOR_SCRAPING * 100)}%).`,
    'Scraping at this point would risk truncating your findings during synthesis.',
    '',
    '**Action**: Proceed directly to **Phase 3 — Synthesis**.',
    'Compile your findings from Phase 1 (search results) and any earlier scrape batches,',
    'and submit your full report now.',
  ].join('\n');

  return {
    name: 'scrape',
    label: 'Scrape',
    description: 'Scrape content from URLs. Context-aware 4-call protocol: handshake → batch 1 → batch 2 (targeted) → optional batch 3 (if context < 40%).',
    promptSnippet: 'Scrape full content from URLs (context-aware protocol)',
    promptGuidelines: [
      'PROTOCOL: This tool uses up to FOUR calls per researcher session.',
      'CALL 1 (Handshake): Provide your intended URLs. Returns links already scraped globally.',
      'CALL 2 (Batch 1): Provide your filtered list (max 3 URLs). Primary broad scraping.',
      'CALL 3 (Batch 2): Targeted follow-up (max 2 URLs). Deduplicated against Batch 1 automatically.',
      'CALL 4 (Batch 3 — optional): Deep-dive; only available when context window is < 40 % full.',
      'CONTEXT LIMIT: All batches are skipped automatically if context exceeds 50 %. Move to synthesis when this happens.',
      `BATCH 1 LIMIT: max ${MAX_SCRAPE_URLS} URLs. BATCH 2 LIMIT: max ${BATCH_2_MAX_SCRAPE_URLS} URLs (higher concurrency). BATCH 3 LIMIT: max ${MAX_SCRAPE_URLS} URLs.`,
      'USE CASES FOR BATCH 2: Targeted follow-up on Batch 1 findings, retry failed scrapes.',
      'USE CASES FOR BATCH 3 (if available): Deep-dive on a narrow sub-topic identified in Batch 1/2.',
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
      const state = options.getGlobalState();

      // ─── CALL 1: Handshake ────────────────────────────────────────────────
      if (callCount === 0) {
        options.tracker.recordCall('scrape');

        const ctxFraction = getContextFraction();
        const ctxPct = Math.round(ctxFraction * 100);

        // Tell the researcher how many batches are realistically available
        const batch3Note = ctxFraction < MAX_CONTEXT_FRACTION_FOR_BATCH3
          ? `A **Batch 3** (optional deep-dive) is available — context is only ${ctxPct}% full.`
          : ctxFraction < MAX_CONTEXT_FRACTION_FOR_SCRAPING
            ? `Batch 3 is **not available** — context is ${ctxPct}% full (threshold: ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}%).`
            : `⚠️ Context is ${ctxPct}% full. **Batches 1–3 may be skipped** — consider proceeding directly to synthesis.`;

        return {
          content: [{
            type: 'text',
            text: [
              '# Scrape Protocol: Call 1 (Handshake)',
              'Here are all links already scraped in this research session:',
              '',
              state.allScrapedLinks && state.allScrapedLinks.length > 0
                ? state.allScrapedLinks.map(l => `- ${l}`).join('\n')
                : '*No links have been scraped yet.*',
              '',
              '**Protocol Overview:**',
              `- **Batch 1** (Call 2): Up to ${MAX_SCRAPE_URLS} URLs — primary broad scraping.`,
              `- **Batch 2** (Call 3): Up to ${BATCH_2_MAX_SCRAPE_URLS} URLs — targeted follow-up (auto-deduped against Batch 1).`,
              `- **Batch 3** (Call 4): Up to ${MAX_SCRAPE_URLS} URLs — deep-dive, context-gated (< ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}% full).`,
              '',
              batch3Note,
              '',
              '**Action Required:**',
              '1. Review the scraped links list above and remove duplicates from your list.',
              `2. Call \`scrape\` again with your filtered list (max ${MAX_SCRAPE_URLS} URLs) to begin Batch 1.`,
            ].join('\n')
          }],
          details: {
            protocol: 'handshake',
            previouslyScrapedCount: state.allScrapedLinks?.length || 0,
            contextFraction: ctxFraction,
          },
        };
      }

      // ─── CALL 2: Batch 1 ──────────────────────────────────────────────────
      if (callCount === 1) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          return { content: [{ type: 'text', text: 'Error: Scrape limit reached.' }], details: { blocked: true } };
        }

        // Context gate
        const ctxFraction = getContextFraction();
        if (ctxFraction >= MAX_CONTEXT_FRACTION_FOR_SCRAPING) {
          return {
            content: [{ type: 'text', text: contextLimitMessage(ctxFraction, 'Batch 1') }],
            details: { skipped: true, reason: 'context_limit', contextFraction: ctxFraction },
          };
        }

        const startTime = Date.now();
        const paramsRecord = params as Record<string, unknown>;
        const urls = (paramsRecord['urls'] as string[] | undefined) || [];
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

        // Record for cross-batch deduplication
        batch1Urls = [...urls];

        // Immediately update global link pool (signals intent to other researchers)
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

        const ctxAfter = getContextFraction();
        const batch2Available = ctxAfter < MAX_CONTEXT_FRACTION_FOR_SCRAPING;
        const batch3Available = ctxAfter < MAX_CONTEXT_FRACTION_FOR_BATCH3;

        let markdown = `# URL Scrape Results (Batch 1 of up to 3)\n\n`;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;

        if (excludeLinks.length > 0) {
          markdown += `**Links considered but not scraped:**\n${excludeLinks.map(l => `- ${l}`).join('\n')}\n\n`;
        }

        if (batch2Available) {
          markdown += `**Batch 2 available** (max ${BATCH_2_MAX_SCRAPE_URLS} URLs, targeted follow-up).\n`;
          if (batch3Available) {
            markdown += `**Batch 3 available** (max ${MAX_SCRAPE_URLS} URLs, context ${Math.round(ctxAfter * 100)}% full — below ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}% threshold).\n`;
          } else {
            markdown += `**Batch 3 not available** (context ${Math.round(ctxAfter * 100)}% full — above ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}% threshold).\n`;
          }
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

      // ─── CALL 3: Batch 2 ──────────────────────────────────────────────────
      if (callCount === 2) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          return { content: [{ type: 'text', text: 'Error: Scrape limit reached.' }], details: { blocked: true } };
        }

        const ctxFraction = getContextFraction();
        if (ctxFraction >= MAX_CONTEXT_FRACTION_FOR_SCRAPING) {
          return {
            content: [{ type: 'text', text: contextLimitMessage(ctxFraction, 'Batch 2') }],
            details: { skipped: true, reason: 'context_limit', contextFraction: ctxFraction },
          };
        }

        const startTime = Date.now();
        const paramsRecord = params as Record<string, unknown>;
        let urls = (paramsRecord['urls'] as string[] | undefined) || [];
        const rawExclude = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        // Batch 2 uses higher default concurrency
        const maxConcurrency = validateMaxConcurrency(
          (paramsRecord['maxConcurrency'] as number | undefined) ?? BATCH_2_DEFAULT_CONCURRENCY
        );

        if (!Array.isArray(urls) || urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // Cross-batch deduplication: remove URLs already scraped in Batch 1
        const batch1Set = new Set(batch1Urls);
        const dedupedUrls = urls.filter(u => !batch1Set.has(u));
        const deduped = urls.length - dedupedUrls.length;
        urls = dedupedUrls;

        if (urls.length === 0) {
          return {
            content: [{ type: 'text', text: `# Batch 2 Skipped\n\nAll ${deduped} URL(s) were already scraped in Batch 1. Proceed to synthesis.` }],
            details: { skipped: true, reason: 'all_duplicates' },
          };
        }

        if (urls.length > BATCH_2_MAX_SCRAPE_URLS) {
          urls = urls.slice(0, BATCH_2_MAX_SCRAPE_URLS);
        }

        // Record for batch 3 deduplication
        batch2Urls = [...urls];
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

        const ctxAfter = getContextFraction();
        const batch3Available = ctxAfter < MAX_CONTEXT_FRACTION_FOR_BATCH3;

        let markdown = `# URL Scrape Results (Batch 2)\n\n`;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s`;
        if (deduped > 0) markdown += `, **Deduplicated (already in Batch 1):** ${deduped}`;
        markdown += '\n\n';

        if (rawExclude.length > 0) {
          markdown += `**Links considered but not scraped:**\n${rawExclude.map(l => `- ${l}`).join('\n')}\n\n`;
        }

        if (batch3Available) {
          markdown += `**Batch 3 available** (context ${Math.round(ctxAfter * 100)}% full — below ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}% threshold). Up to ${MAX_SCRAPE_URLS} more URLs for deep-dive.\n\n`;
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
          details: { urls, excludeLinks: rawExclude, successfulCount: successful.length, duration: elapsed, batch: 2, deduped },
        };
      }

      // ─── CALL 4: Batch 3 (context-gated optional deep-dive) ───────────────
      if (callCount === 3) {
        const allowed = options.tracker.recordCall('scrape');
        if (!allowed) {
          return { content: [{ type: 'text', text: 'Error: Scrape limit reached.' }], details: { blocked: true } };
        }

        const ctxFraction = getContextFraction();
        if (ctxFraction >= MAX_CONTEXT_FRACTION_FOR_BATCH3) {
          return {
            content: [{
              type: 'text',
              text: [
                `# Batch 3 Unavailable — Context Budget Reached`,
                '',
                `Context is **${Math.round(ctxFraction * 100)}% full** (threshold for Batch 3: ${Math.round(MAX_CONTEXT_FRACTION_FOR_BATCH3 * 100)}%).`,
                '',
                '**Action**: Proceed directly to **Phase 3 — Synthesis** with findings from Batches 1 and 2.',
              ].join('\n'),
            }],
            details: { skipped: true, reason: 'context_limit_batch3', contextFraction: ctxFraction },
          };
        }

        const startTime = Date.now();
        const paramsRecord = params as Record<string, unknown>;
        let urls = (paramsRecord['urls'] as string[] | undefined) || [];
        const rawExclude = (paramsRecord['excludeLinks'] as string[] | undefined) || [];
        const maxConcurrency = validateMaxConcurrency(paramsRecord['maxConcurrency'] as number | undefined);

        if (!Array.isArray(urls) || urls.length === 0 || !urls.every(u => typeof u === 'string')) {
          throw new Error('At least one valid URL string is required for scraping.');
        }

        // Deduplicate against Batch 1 and Batch 2
        const prevScraped = new Set([...batch1Urls, ...batch2Urls]);
        const dedupedUrls = urls.filter(u => !prevScraped.has(u));
        const deduped = urls.length - dedupedUrls.length;
        urls = dedupedUrls;

        if (urls.length === 0) {
          return {
            content: [{ type: 'text', text: `# Batch 3 Skipped\n\nAll ${deduped} URL(s) were already scraped in previous batches. Proceed to synthesis.` }],
            details: { skipped: true, reason: 'all_duplicates' },
          };
        }

        if (urls.length > MAX_SCRAPE_URLS) {
          urls = urls.slice(0, MAX_SCRAPE_URLS);
        }

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

        let markdown = `# URL Scrape Results (Batch 3 — Deep-Dive)\n\n`;
        markdown += `**Successful:** ${successful.length}, **Failed:** ${failed.length}, **Duration:** ${(elapsed / 1000).toFixed(2)}s`;
        if (deduped > 0) markdown += `, **Deduplicated:** ${deduped}`;
        markdown += '\n\n';
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
          details: { urls, excludeLinks: rawExclude, successfulCount: successful.length, duration: elapsed, batch: 3, deduped },
        };
      }

      // ─── CALL 5+: Locked ──────────────────────────────────────────────────
      return {
        content: [{ type: 'text', text: 'Locked: All scrape batches have been used. Proceed directly to Phase 3 — Synthesis.' }],
        details: { locked: true },
      };
    },
  };
}
