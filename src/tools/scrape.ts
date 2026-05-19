/**
 * scrape Tool
 *
 * Scrape full content from URLs using a batch protocol.
 * Batch 1, Batch 2, etc. up to configured limit.
 * After all batches are exhausted, the tool returns the limit-reached message.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { scrape } from '../web-research/scrapers.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { deduplicateUrls, normalizeUrl } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_DEFAULT_CONCURRENCY,
  getMaxScrapeBatches,
} from '../constants.ts';
import type { Config } from '../config.ts';
import { isKnowledgeStoreReady, getStore, getWriterQueue } from '../knowledge/index.ts';
import { logger } from '../logger.ts';

export function createScrapeTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState: () => SystemResearchState;
  updateGlobalLinks: (links: string[]) => void;
  onLinksScraped?: (links: string[]) => void;
  config?: Config;
}): ToolDefinition {

  const maxScrapeBatches = getMaxScrapeBatches(options.config);

  const ScrapeParams = Type.Object({
    urls: Type.Array(Type.String(), { minItems: 1 }),
    maxConcurrency: Type.Optional(Type.Number({ default: 10, minimum: 1, maximum: 20 })),
  });

  // Check tracker limit to determine actual effective limit for protocol display
  const trackerLimit = options.tracker.getToolLimit('scrape');
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
    label: 'Scrape',
    description: `Scrape content from URLs. Supports HTML and PDF. Up to ${maxScrapeBatches} batches.`,
    promptSnippet: `Scrape full content from URLs (up to ${maxScrapeBatches} batches)`,
    promptGuidelines: [
      batchProtocolText,
      `Up to ${MAX_SCRAPE_URLS} URLs per batch.`,
      'Handshake is ELIMINATED. Start scraping immediately.',
      'Shared links from siblings are injected in real-time via steering.',
      'PDFs are auto-detected and extracted with high fidelity.',
    ],
    parameters: ScrapeParams,
    async execute(_callId, params, signal): Promise<AgentToolResult<unknown>> {
      const callCount = options.tracker.getToolCallCount('scrape');
      const limit = options.tracker.getToolLimit('scrape') ?? maxScrapeBatches;
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
      
      let urls: string[] = [];
      if (Array.isArray(rawUrls)) {
          rawUrls.forEach(u => {
              if (typeof u === 'string') {
                  if ((u.includes('[') || u.includes(']')) && u.includes(',')) {
                      const cleaned = u.replace(/[\[\]]/g, '').split(',').map(s => s.trim());
                      urls.push(...cleaned);
                  } else {
                      urls.push(u.trim());
                  }
              }
          });
      } else if (typeof rawUrls === 'string') {
          const s = rawUrls as string;
          urls = s.replace(/[\[\]]/g, '').split(',').map(u => u.trim());
      }
      
      urls = Array.from(new Set(urls)).filter(u => u.startsWith('http'));

      if (urls.length === 0) {
          return { content: [{ type: 'text', text: 'No valid URLs provided for scraping.' }], details: { error: 'invalid_input' } };
      }

      const batchLabel = `Batch ${callCount + 1}`;

      // Record scrape call AFTER limit check (effective limit = limit calls)
      options.tracker.recordCall('scrape');
      const scrapeStartTime = Date.now();
      
      // Global Deduplication
      const { kept: dedupedUrls, duplicates } = deduplicateUrls(urls, options.getGlobalState().researchId);
      let dedupNote = duplicates.length > 0 ? `**Global Deduplication**: ${duplicates.length} URL(s) skipped (already in pool).\n\n` : '';
      
      if (dedupedUrls.length === 0) {
          return { content: [{ type: 'text', text: `# ${batchLabel} Skipped\n\nAll URLs were already in the global pool.` }], details: { all_duplicates: true } };
      }

      const finalUrls = dedupedUrls.slice(0, MAX_SCRAPE_URLS);
      options.updateGlobalLinks(finalUrls);

      const defaultConcurrency = callCount >= 1 ? BATCH_2_DEFAULT_CONCURRENCY : 10;

      // Cache Lookup
      const cachedResults: { url: string; markdown: string }[] = [];
      const urlsToFetch: string[] = [];
      
      if (isKnowledgeStoreReady()) {
        const store = getStore();
        for (const url of finalUrls) {
          const normalized = normalizeUrl(url);
          const fullDoc = await store.rebuildDocument(normalized);

          if (fullDoc) {
            cachedResults.push({ url: url, markdown: fullDoc });
          } else {
            urlsToFetch.push(url);
          }
        }
        if (cachedResults.length > 0) {
          logger.log(`[scrape] Cache: ${cachedResults.length} hit(s), ${urlsToFetch.length} miss(es) out of ${finalUrls.length} URLs`);
        }
      } else {
        urlsToFetch.push(...finalUrls);
      }

      let freshResults: any[] = [];
      if (urlsToFetch.length > 0) {
        const scrapeResults = await scrape(urlsToFetch, p['maxConcurrency'] || defaultConcurrency, signal);
        freshResults = Array.isArray(scrapeResults) ? scrapeResults : [];
      }

      const successfulFresh = freshResults.filter(r => r.success);
      const failedFresh = freshResults.filter(r => !r.success);
      
      // Background Ingestion
      if (isKnowledgeStoreReady() && successfulFresh.length > 0) {
        const writer = getWriterQueue();
        for (const res of successfulFresh) {
          writer.enqueue({ url: normalizeUrl(res.url), markdown: res.markdown || '' });
        }
        logger.log(`[scrape] Enqueued ${successfulFresh.length} fresh result(s) for background ingestion`);
      }

      // Merge results
      const allSuccessful = [
        ...cachedResults.map(r => ({ ...r, success: true as const })),
        ...successfulFresh
      ];

      if (allSuccessful.length > 0 && options.onLinksScraped) {
          options.onLinksScraped(allSuccessful.map(r => r.url));
      }

      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      if (cachedResults.length > 0) {
        markdown += `**Cache Hits:** ${cachedResults.length} (retrieved from local knowledge store)\n`;
      }
      markdown += `**Successful:** ${allSuccessful.length}, **Failed:** ${failedFresh.length}, **Duration:** ${((Date.now() - scrapeStartTime)/1000).toFixed(2)}s\n\n`;

      for (const res of allSuccessful) {
          const content = res.markdown || '';
          markdown += `### ${res.url}\n${content}\n\n---\n\n`;
      }

      if (failedFresh.length > 0) {
          markdown += `## Failed URLs\n\n`;
          for (const res of failedFresh) {
              const error = typeof res.error === 'string' && res.error.length > 0 ? res.error : 'Unknown error';
              markdown += `- ${res.url}: ${error}\n`;
          }
          markdown += '\n';
      }
      
      return { 
        content: [{ type: 'text', text: markdown }], 
        details: { 
          batch: callCount + 1, 
          count: allSuccessful.length,
          cacheHits: cachedResults.length 
        } 
      };
    },
  };
}
