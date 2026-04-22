/**
 * search Tool
 *
 * Perform high-fidelity browser-based searches (10-150 queries).
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { search } from '../web-research/search.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';

export function createSearchTool(_options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
}): ToolDefinition {

  return {
    name: 'search',
    label: 'Search',
    description: 'Search the web using a massive list of queries (10-150).',
    promptSnippet: 'Search the web with a high-fidelity browser (minimum 10 queries, max 150)',
    promptGuidelines: [
      'CRITICAL: This tool requires a minimum of 10 and a maximum of 150 queries per call.',
      'Use this tool to cast a very wide net. The system will handle pagination and extraction.',
      'A researcher agent is limited to EXACTLY ONE search call. Make it count.',
      'The coordinator uses this tool to seed initial data for all planned researchers.',
      'Return results are high-fidelity snippets. Use scrape for full content.',
      'CRITICAL: You are allowed a maximum of 4 gathering calls total across ALL tools. Use them for breadth.',
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { 
          minItems: 10, 
          maxItems: 150,
          description: 'A list of 10-150 specific search queries to execute.' 
      }),
    }),
    execute: async (_callId, params, _state, _unsub, ctx): Promise<AgentToolResult<unknown>> => {
      const startTime = Date.now();
      const p = params as Record<string, any>;
      const queries = (p['queries'] || []) as string[];

      try {
        if (queries.length === 0) {
          throw new Error('At least one query is required');
        }
        if (!p['queries']) {
          throw new Error('Invalid parameters for search');
        }

        const allowed = _options.tracker.recordCall('search');
        if (!allowed) {
          throw new Error('GATHERING LIMIT REACHED. You have reached the maximum number of search calls allowed. Synthesize your findings and complete the task.');
        }

        const results = await search(queries, undefined, ctx.signal);
        const elapsed = Date.now() - startTime;

        let output = `# Search Results (${queries.length} queries)\n\n`;
        results.forEach((r, i) => {
          output += `## Query ${i + 1}: ${r.query}\n`;
          if (r.results.length === 0) {
            output += `*No results found.*\n\n`;
          } else {
            r.results.forEach((item, j) => {
              output += `[${j + 1}] **${item.title}**\n${item.url}\n${item.content}\n\n`;
            });
          }
        });

        return {
          content: [{ type: 'text', text: output }],
          details: {
            queryCount: queries.length,
            duration: elapsed,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const elapsed = Date.now() - startTime;
        return {
          content: [
            {
              type: 'text',
              text: `# Web Search Failed\n\n**Error:** ${errorMsg}\n\nFailed to search the web. This may be due to network issues or browser pool exhaustion.`,
            },
          ],
          details: {
            queries,
            error: errorMsg,
            duration: elapsed,
          },
        };
      }
    },
  };
}
