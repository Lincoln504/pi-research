/**
 * scrape Tool
 *
 * Scrape full content from URLs using a batch protocol.
 * Batch 1, Batch 2, etc. up to configured limit.
 * After all batches are exhausted, the tool returns the limit-reached message.
 * Supports PDF extraction and automatic caching/retrieval from Knowledge Store.
 * Optionally context-gated: blocks further scraping when projected context usage
 * exceeds MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING of the total context window.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { scrape } from '../web-research/web-scraper.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { deduplicateUrls, normalizeUrl, cacheScrapedContent, getCachedScrapedContent } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_DEFAULT_CONCURRENCY,
  getMaxScrapeBatches,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from '../constants.ts';
import { type Config, getConfig } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';

export function createScrapeTool(options: {
  ctx: ExtensionContext;
  tracker?: ToolUsageTracker;
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  onLinksScraped?: (links: string[]) => void;
  /** Returns total tokens used so far in this researcher's session (for context gating). */
  getTokensUsed?: () => number;
  /** Context window size in tokens; defaults to DEFAULT_MODEL_CONTEXT_WINDOW. */
  contextWindowSize?: number;
  config?: Config;
}): ToolDefinition {
  const config = options.config || getConfig();
  const maxScrapeBatches = getMaxScrapeBatches(config);

  // Fallback global state when no orchestration context is provided
  const fallbackState: SystemResearchState = {
    version: 1,
    researchId: 'standalone',
    rootQuery: '',
    complexity: 1,
    currentRound: 1,
    status: 'researching',
    lastUpdated: Date.now(),
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {},
  };
  const getGlobalState = options.getGlobalState ?? (() => fallbackState);
  const updateGlobalLinks = options.updateGlobalLinks ?? ((links: string[]) => {
    fallbackState.allScrapedLinks = [...new Set([...fallbackState.allScrapedLinks, ...links])];
  });

  const ScrapeParams = Type.Object({
    urls: Type.Array(Type.String({ description: 'The URLs to scrape' }), { minItems: 1, maxItems: 20 }),
    maxConcurrency: Type.Optional(Type.Number({ default: config.MAX_CONCURRENT_SCRAPES, minimum: 1, maximum: 20 })),
  });

  // Determine the effective batch limit for the protocol display text
  const trackerLimit = options.tracker?.getToolLimit('scrape');
  const effectiveLimit = trackerLimit !== undefined && trackerLimit < maxScrapeBatches ? trackerLimit : maxScrapeBatches;
  let batchProtocolText: string;
  if (effectiveLimit > 6) {
    batchProtocolText = `PROTOCOL: Batch 1 → Batch 2 → ... (up to ${effectiveLimit} batches)`;
  } else {
    const batchNumbers = Array.from({ length: effectiveLimit }, (_, i) => `Batch ${i + 1}`).join(' → ');
    batchProtocolText = `PROTOCOL: ${batchNumbers} (up to ${MAX_SCRAPE_URLS} URLs each).`;
  }

  return {
    name: 'scrape',
    label: 'Scrape Web Pages',
    description: `Fetch and extract the main content (as markdown) from one or more URLs. Use this to read the full text of relevant search results. Supports PDFs. Up to ${maxScrapeBatches} batches.`,
    promptSnippet: `Read full content of web pages or PDFs (up to ${maxScrapeBatches} batches)`,
    promptGuidelines: [
      batchProtocolText,
      `Up to ${MAX_SCRAPE_URLS} URLs per batch.`,
      'Handshake is ELIMINATED. Start scraping immediately.',
      'Shared links from siblings are injected in real-time via steering.',
      'PDFs are auto-detected and extracted with high fidelity.',
    ],
    parameters: ScrapeParams,
    async execute(_callId: string, params: unknown, signal: AbortSignal, _onUpdate: AgentToolUpdateCallback<any>): Promise<AgentToolResult<unknown>> {
      const callStartTime = Date.now();
      metrics.increment('tool_scrape_calls_total', 1);

      // Rate-limit enforcement (only when tracker is present)
      if (options.tracker) {
        const callCount = options.tracker.getToolCallCount('scrape');
        const limit = options.tracker.getToolLimit('scrape') ?? maxScrapeBatches;
        if (callCount >= limit) {
          metrics.increment('tool_scrape_calls_total', 1, { status: 'rate_limited' });
          return {
            content: [{ type: 'text', text: options.tracker.getLimitMessage('scrape') }],
            details: { blocked: true, reason: 'limit_reached' },
          };
        }
      }

      if (!Value.Check(ScrapeParams, params)) {
        metrics.increment('tool_scrape_calls_total', 1, { status: 'invalid_params' });
        return {
          content: [{ type: 'text', text: 'Invalid parameters for scrape tool. Expected an array of URLs.' }],
          details: { error: 'invalid_params' },
        };
      }

      const p = params as Static<typeof ScrapeParams>;
      const rawUrls = p.urls.map(u => u.trim()).filter(u => u.length > 0);

      if (rawUrls.length === 0) {
        metrics.increment('tool_scrape_calls_total', 1, { status: 'no_valid_urls' });
        return {
          content: [{ type: 'text', text: 'No valid URLs provided for scraping.' }],
          details: { error: 'no_urls' },
        };
      }

      // Context gate: block if projected token usage would exceed threshold
      if (options.getTokensUsed) {
        const ctxWindow = options.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_WINDOW;
        const tokensUsed = options.getTokensUsed();
        const projected = (tokensUsed + rawUrls.length * config.AVG_TOKENS_PER_SCRAPE) / ctxWindow;
        if (projected >= config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING) {
          const pct = Math.round(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING * 100);
          metrics.increment('tool_scrape_calls_total', 1, { status: 'context_limit' });
          return {
            content: [{
              type: 'text',
              text: `# Scrape Blocked — Context Limit Reached\n\n` +
                `Projected context usage (${Math.round(projected * 100)}%) would exceed the ${pct}% threshold. ` +
                `Synthesize your findings from what you have gathered so far.`,
            }],
            details: { blocked: true, reason: 'context_limit' },
          };
        }
      }

      const callCount = options.tracker?.getToolCallCount('scrape') ?? 0;
      const batchLabel = `Batch ${callCount + 1}`;
      options.tracker?.recordCall('scrape');
      const scrapeStartTime = Date.now();

      // Global deduplication: Identify URLs already scraped in this session
      const { kept: dedupedUrls, duplicates } = deduplicateUrls(rawUrls, getGlobalState().researchId);
      const dedupNote = duplicates.length > 0
        ? `**Global Cache Hit**: ${duplicates.length} URL(s) retrieved from session memory (already scraped).\n\n`
        : '';
      metrics.increment('tool_scrape_duplicates_total', duplicates.length);

      // Even for duplicates, we want to return the content if we have it in the session cache
      const duplicateResults: { url: string; markdown: string; success: true }[] = [];
      for (const url of duplicates) {
        const cachedContent = getCachedScrapedContent(getGlobalState().researchId, url);
        if (cachedContent) {
          duplicateResults.push({ url, markdown: cachedContent, success: true });
        }
      }

      if (dedupedUrls.length === 0 && duplicateResults.length === 0) {
        metrics.increment('tool_scrape_calls_total', 1, { status: 'all_duplicates_no_content' });
        return {
          content: [{ type: 'text', text: `# ${batchLabel} Skipped\n\nAll URLs were already in the global pool, but no cached content was available.` }],
          details: { all_duplicates: true },
        };
      }

      const finalUrls = dedupedUrls.slice(0, MAX_SCRAPE_URLS);
      updateGlobalLinks(finalUrls);

      const defaultConcurrency = callCount >= 1 ? BATCH_2_DEFAULT_CONCURRENCY : config.MAX_CONCURRENT_SCRAPES;
      const urlsToFetch = [...finalUrls];
      const cachedResults: { url: string; markdown: string }[] = [];

      // Attempt to retrieve from knowledge-store cache if enabled
      if (config.KNOWLEDGE_STORE_ENABLED) {
        try {
          const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
          const store = await service.getStore();

          for (const url of finalUrls) {
            const normalized = normalizeUrl(url);
            const cacheHit = await store.rebuildDocument(normalized);

            if (cacheHit) {
              cachedResults.push({ url, markdown: cacheHit.text });
              const idx = urlsToFetch.indexOf(url);
              if (idx !== -1) urlsToFetch.splice(idx, 1);
            }
          }
          if (cachedResults.length > 0) {
            metrics.increment('tool_scrape_cache_hits_total', cachedResults.length);
            logger.log(`[scrape] Cache: ${cachedResults.length} full-text hit(s) out of ${finalUrls.length} URL(s)`);
          }
        } catch (err) {
          const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE).catch(() => null);
          if (!service?.isReady()) {
            metrics.increment('tool_scrape_cache_errors_total', 1, { reason: 'store_not_ready' });
            logger.warn(`[scrape] Knowledge store not initialized — all ${finalUrls.length} URL(s) will be scraped fresh`);
          } else {
            metrics.increment('tool_scrape_cache_errors_total', 1, { reason: 'lookup_failed' });
            logger.warn('[scrape] Knowledge store cache lookup failed (non-fatal):', err);
          }
        }
      }

      let freshResults: any[] = [];
      if (urlsToFetch.length > 0) {
        const concurrency = p.maxConcurrency || defaultConcurrency;
        // Pass options.config directly (may be undefined) so the web-scraper
        // falls back to its own getConfig() when not explicitly provided.
        const scrapeResults = await scrape(urlsToFetch, concurrency, signal, options.config);
        freshResults = Array.isArray(scrapeResults) ? scrapeResults : [];

        // Cache fresh content for same-session retrieval
        for (const res of freshResults) {
          if (res.success && res.markdown) {
            cacheScrapedContent(getGlobalState().researchId, res.url, res.markdown);
          }
        }
      }

      const successfulFresh = freshResults.filter(r => r.success);
      const failedFresh = freshResults.filter(r => !r.success);

      const allSuccessful = [
        ...duplicateResults.map(r => ({ ...r, error: undefined, source: 'session-cache' })),
        ...cachedResults.map(r => ({ ...r, success: true as const, error: undefined, source: 'knowledge-store' })),
        ...successfulFresh,
      ];

      if (allSuccessful.length > 0 && options.onLinksScraped) {
        options.onLinksScraped(allSuccessful.map(r => r.url));
      }

      const totalDuration = Date.now() - callStartTime;
      const scrapeDuration = Date.now() - scrapeStartTime;
      metrics.observe('tool_scrape_total_duration_ms', totalDuration, { status: 'success' });
      metrics.observe('tool_scrape_fetch_duration_ms', scrapeDuration);
      metrics.increment('tool_scrape_calls_total', 1, { status: 'success' });
      metrics.increment('tool_scrape_successful_total', allSuccessful.length);
      metrics.increment('tool_scrape_failed_total', failedFresh.length);

      const successText = allSuccessful.length === 1 ? '1 successful' : `${allSuccessful.length} successful`;
      const failText = failedFresh.length === 1 ? '1 failed' : `${failedFresh.length} failed`;
      let markdown = `# URL Scrape Results (${successText})\n\n${dedupNote}`;
      markdown += `**Successful:** ${allSuccessful.length}, **Failed:** ${failedFresh.length}, **Duration:** ${(totalDuration / 1000).toFixed(2)}s\n\n`;

      for (const res of allSuccessful) {
        let sourceLabel: string;
        if ((res as any).source === 'session-cache') {
          sourceLabel = 'Source: Session Memory (Already scraped by sibling/previous round)';
        } else if ((res as any).source === 'knowledge-store') {
          sourceLabel = 'Source: Knowledge Store (Local Cache)';
        } else {
          sourceLabel = 'Source: Scrape';
        }
        
        markdown += `### ${res.url}\n`;
        markdown += `**${sourceLabel}**\n\n`;
        markdown += `${res.markdown || ''}\n\n---\n\n`;
      }

      if (failedFresh.length > 0) {
        markdown += `## Failed to Scrape (${failText})\n\n`;
        for (const res of failedFresh) {
          const error = typeof res.error === 'string' && res.error.length > 0 ? res.error : 'Unknown error';
          markdown += `- ${res.url}: ${error}\n`;
        }
        markdown += '\n';
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: {
          total: finalUrls.length,
          successful: allSuccessful.length,
          failed: failedFresh.length,
          cached: cachedResults.length,
          fresh: successfulFresh.length,
        },
      };
    },
  };
}
