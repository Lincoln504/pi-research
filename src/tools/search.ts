/**
 * search Tool
 *
 * Perform comprehensive browser-based searches (10-50 queries).
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { search } from '../web-research/search.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import { logger } from '../logger.ts';
import type { Config } from '../config.ts';
import { metrics } from '../utils/metrics.ts';

export function createSearchTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  onProgress?: (links: number) => void;
  config?: Config;
}): ToolDefinition {

  const SearchParams = Type.Object({
    queries: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 50,
        description: 'A list of 5-30 search queries to execute (minimum 1).'
    }),
  });

  return {
    name: 'search',
    label: 'Search',
    description: 'Search the web using a list of queries (5-30, minimum 1) for targeted coverage.',
    promptSnippet: 'Web search (5-30 queries, minimum 1)',
    promptGuidelines: [
      'CRITICAL: Provide 5-30 queries per call (minimum 1).',
      'COVERAGE: Include query variations, related concepts, and specific data points.',
      'EFFICIENT: The system processes all queries in one call — maximize each call.',
      'Agents are limited to EXACTLY ONE search call. Make it count by covering everything remaining.',
      'Return results are high-fidelity snippets. Use the scrape tool for full deep-dives.',
    ],
    parameters: SearchParams,
    async execute(_callId, params, signal): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      metrics.increment('tool_search_calls_total', 1);

      if (!Value.Check(SearchParams, params)) {
          metrics.increment('tool_search_calls_total', 1, { status: 'invalid_params' });
          return {
            content: [{ type: 'text', text: 'Invalid parameters for search tool. Expected an array of 5-30 queries (minimum 1).' }],
            details: { error: 'invalid_parameters' },
          };
      }

      const p = params as Static<typeof SearchParams>;
      let queries = p.queries;
      metrics.increment('tool_search_queries_total', queries.length);

      if (queries.length < 1) {
        metrics.increment('tool_search_calls_total', 1, { status: 'insufficient_queries' });
        throw new Error(`Insufficient queries: ${queries.length}. Provide at least 1 highly specific queries.`);
      }

      // Hard cap for safety
      if (queries.length > 40) {
          logger.warn(`[search tool] Capping tool call queries: ${queries.length} → 40`);
          metrics.increment('tool_search_capped_queries_total', queries.length - 40);
          queries = queries.slice(0, 40);
      }

      const allowed = options.tracker.recordCall('search');
      if (!allowed) {
          metrics.increment('tool_search_calls_total', 1, { status: 'rate_limited' });
          return {
            content: [{ type: 'text', text: options.tracker.getLimitMessage('search') }],
            details: { blocked: true, reason: 'limit_reached' },
          };
      }

      try {
        const results = await search(queries, options.config, signal, options.onProgress);
        const elapsed = Date.now() - startTime;
        
        const totalResults = results.reduce((sum, r) => sum + r.results.length, 0);
        metrics.observe('tool_search_duration_ms', elapsed, { status: 'success' });
        metrics.increment('tool_search_calls_total', 1, { status: 'success' });
        metrics.increment('tool_search_results_total', totalResults);
        metrics.increment('tool_search_successful_queries_total', results.filter(r => r.results.length > 0).length);

        let markdown = `# Web Search Results (${queries.length} queries)\n\n`;
        markdown += `**Source: Web Search**\n\n`;
        results.forEach((r, i) => {
          markdown += `## Query ${i + 1}: ${r.query}\n`;
          if (r.results.length === 0) {
            markdown += `*No results found.*\n\n`;
          } else {
            r.results.forEach((item, j) => {
              markdown += `[${j + 1}] **${item.title}**\n${item.url}\n${item.content}\n\n`;
            });
          }
        });

        return {
          content: [{ type: 'text', text: markdown }],
          details: { queryCount: queries.length, duration: elapsed },
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        metrics.observe('tool_search_duration_ms', elapsed, { status: 'error' });
        metrics.increment('tool_search_calls_total', 1, { status: 'error' });
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `# Search Failed\n\n${msg}` }],
          details: { error: msg, duration: elapsed },
        };
      }
    },
  };
}
