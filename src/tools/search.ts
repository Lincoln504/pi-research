/**
 * search Tool
 *
 * Perform high-fidelity browser-based searches (10-150 queries).
 * Simplified for universal use by researchers and coordinators.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { search } from '../web-research/search.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';

export function createSearchTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
}): ToolDefinition {

  return {
    name: 'search',
    label: 'Search',
    description: 'Search the web using a massive list of queries (10-150).',
    promptSnippet: 'Search the web with a high-fidelity browser (minimum 10 queries, max 150)',
    promptGuidelines: [
      'CRITICAL: Provide exactly one list of 10-150 queries.',
      'The system handles pagination and extraction for you.',
      'Agents are limited to EXACTLY ONE search call. Make it count.',
      'Coordinates broad discovery before targeted scraping.',
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { 
          minItems: 10, 
          maxItems: 150,
          description: 'A list of 10-150 specific search queries to execute.' 
      }),
    }),
    async execute(_callId, params, signal): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      const p = params as Record<string, any>;
      const queries = (p['queries'] || []) as string[];

      if (queries.length < 10) {
        throw new Error(`Insufficient queries: ${queries.length}. Provide at least 10 highly specific queries.`);
      }

      const allowed = options.tracker.recordCall('search');
      if (!allowed) {
        throw new Error('Search limit reached. Only one search call is permitted per agent.');
      }

      try {
        const results = await search(queries, undefined, signal);
        const elapsed = Date.now() - startTime;

        let markdown = `# Web Search Results (${queries.length} queries)\n\n`;
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
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `# Search Failed\n\n${msg}` }],
          details: { error: msg, duration: Date.now() - startTime },
        };
      }
    },
  };
}
