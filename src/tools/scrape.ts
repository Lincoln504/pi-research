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
import { deduplicateUrls, normalizeUrl, cacheScrapedContent } from '../utils/shared-links.ts';
import {
  MAX_SCRAPE_URLS,
  BATCH_2_DEFAULT_CONCURRENCY,
  getMaxScrapeBatches,
} from '../constants.ts';
import { type Config, DEFAULTS } from '../config.ts';
import { getStore, getWriterQueue } from '../knowledge/index.ts';
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
                  if (u.startsWith('[') && u.endsWith(']') && u.includes(',')) {
                      const cleaned = u.replace(/[[\]]/g, '').split(',').map(s => s.trim());
                      urls.push(...cleaned);
                  } else {
                      urls.push(u.trim());
                  }
              }
          });
      } else if (typeof rawUrls === 'string') {
          const s = rawUrls as string;
          urls = s.replace(/[[\]]/g, '').split(',').map(u => u.trim());
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

      // Cache Lookup (Historical Summaries)
      const summaries: { url: string; text: string }[] = [];
      const cachedResults: { url: string; markdown: string }[] = [];
      const urlsToFetch: string[] = [...finalUrls];
      
      const knowledgeStoreEnabled = options.config?.KNOWLEDGE_STORE_ENABLED ?? DEFAULTS.KNOWLEDGE_STORE_ENABLED;
      if (knowledgeStoreEnabled) {
        try {
          const store = await getStore();
          for (const url of finalUrls) {
            const normalized = normalizeUrl(url);
            const cacheHit = await store.rebuildDocument(normalized);

            if (cacheHit) {
              const ingestionType = cacheHit.metadata['ingestionType'];
              // rebuildDocument filters to raw-content only; synthesis-description entries
              // are never returned here (they are for vector search, not cache retrieval).
              if (ingestionType === 'raw-content') {
                cachedResults.push({ url, markdown: cacheHit.text });
                const idx = urlsToFetch.indexOf(url);
                if (idx !== -1) urlsToFetch.splice(idx, 1);
              } else if (ingestionType === 'summary') {
                // Legacy format: rawText is in metadata, text contains agent description
                const rawText = cacheHit.metadata['rawText'];
                if (rawText) {
                  cachedResults.push({ url, markdown: rawText });
                  summaries.push({ url, text: cacheHit.text });
                  const idx = urlsToFetch.indexOf(url);
                  if (idx !== -1) urlsToFetch.splice(idx, 1);
                } else {
                  summaries.push({ url, text: cacheHit.text });
                }
              } else {
                // Legacy formats for backward compatibility
                const rawText = cacheHit.metadata['rawText'];
                if (rawText) {
                  cachedResults.push({ url, markdown: rawText });
                }
                const agentDescription = cacheHit.metadata['agentDescription'];
                if (agentDescription) {
                  summaries.push({ url, text: agentDescription });
                }
                const idx = urlsToFetch.indexOf(url);
                if (idx !== -1) urlsToFetch.splice(idx, 1);
              }
            }
          }
          if (cachedResults.length > 0 || summaries.length > 0) {
            logger.log(`[scrape] Cache: ${cachedResults.length} full-text hits, ${summaries.length} summary hints out of ${finalUrls.length} URLs`);
          }
        } catch (err) {
          logger.warn('[scrape] Knowledge store cache lookup failed (non-fatal):', err);
        }
      }

      let freshResults: any[] = [];
      if (urlsToFetch.length > 0) {
        const scrapeResults = await scrape(urlsToFetch, p['maxConcurrency'] || defaultConcurrency, signal, options.config);
        freshResults = Array.isArray(scrapeResults) ? scrapeResults : [];
        
        // Store clean scraped markdown as raw content (for retrieval, NOT for vector search)
        if (knowledgeStoreEnabled) {
          try {
            const writer = await getWriterQueue();
            for (const res of freshResults) {
              if (res.success && res.markdown) {
                cacheScrapedContent(options.getGlobalState().researchId, res.url, res.markdown);
                // Store raw markdown with 'raw-content' type - for retrieval only, vector search uses descriptions
                writer.enqueue({ 
                  url: normalizeUrl(res.url), 
                  markdown: res.markdown,
                  metadata: { 
                    ingestionType: 'raw-content', 
                    source: 'scrape-tool',
                    scrapedAt: new Date().toISOString()
                  }
                });
              }
            }
          } catch (err) {
            logger.warn('[scrape] Knowledge store ingestion failed (non-fatal):', err);
            // Fallback to memory cache
            for (const res of freshResults) {
              if (res.success && res.markdown) {
                cacheScrapedContent(options.getGlobalState().researchId, res.url, res.markdown);
              }
            }
          }
        } else {
          // Fallback to caching only if knowledge store is not enabled
          for (const res of freshResults) {
            if (res.success && res.markdown) {
              cacheScrapedContent(options.getGlobalState().researchId, res.url, res.markdown);
            }
          }
        }
      }

      const successfulFresh = freshResults.filter(r => r.success);
      const failedFresh = freshResults.filter(r => !r.success);
      
      // Clean scraped markdown is stored with ingestionType: 'raw-content'.
      // The orchestrator creates separate entries with ingestionType: 'synthesis-description'
      // during final synthesis evaluation for vector/semantic search.

      // Merge results
      const allSuccessful = [
        ...cachedResults.map(r => ({ ...r, success: true as const })),
        ...successfulFresh
      ];

      if (allSuccessful.length > 0 && options.onLinksScraped) {
          options.onLinksScraped(allSuccessful.map(r => r.url));
      }

      let markdown = `# URL Scrape Results (${batchLabel})\n\n${dedupNote}`;
      if (summaries.length > 0) {
        markdown += `**Historical Summaries:** ${summaries.length} (found in knowledge store, fresh content also fetched below)\n`;
      }
      markdown += `**Successful:** ${allSuccessful.length}, **Failed:** ${failedFresh.length}, **Duration:** ${((Date.now() - scrapeStartTime)/1000).toFixed(2)}s\n\n`;

      for (const res of allSuccessful) {
          const content = res.markdown || '';
          const summary = summaries.find(s => normalizeUrl(s.url) === normalizeUrl(res.url));
          markdown += `### ${res.url}\n`;
          if (summary) {
            markdown += `> **Historical Summary (Previous Finding):** ${summary.text}\n\n`;
          }
          markdown += `${content}\n\n---\n\n`;
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
          summaryHints: summaries.length 
        } 
      };
    },
  };
}
