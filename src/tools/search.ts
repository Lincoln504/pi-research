/**
 * search Tool
 *
 * Search the web via SearXNG and return URLs, titles, and snippets.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { search } from '../web-research/search.js';

interface SearchParams {
  queries: string[];
  maxResults?: number;
  [key: string]: unknown;
}

export function createSearchTool(_options: {
  ctx: ExtensionContext;
}): ToolDefinition {

  return {
    name: 'search',
    label: 'Search',
    description: 'Search the web via SearXNG and return URLs, titles, and snippets.',
    promptSnippet: 'Search the web for URLs and information (returns snippets only, not full content)',
    promptGuidelines: [
      'Use search when you need to find URLs or information about a topic.',
      'This returns search results with snippets. Use scrape to get full content from specific URLs.',
      'For security research, use security_search to query vulnerability databases.',
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({
        description: 'Search queries - plain text strings, one or more',
      }), { minItems: 1 }),
      maxResults: Type.Optional(Type.Number({
        description: 'Maximum results to show per query (default: 20)',
        default: 20,
        minimum: 1,
        maximum: 30,
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      const paramsRecord = params as Record<string, unknown>;

      if (!isSearchParams(paramsRecord)) {
        throw new Error('Invalid parameters for search');
      }

      const queries = paramsRecord['queries'] as string[];
      if (queries.length === 0) {
        throw new Error('At least one query is required');
      }

      const maxResults = (paramsRecord['maxResults'] as number | undefined) ?? 20;

      const queriesText = queries.length === 1 ? 'query' : 'queries';

      const queryResults = await search(queries);

      const elapsed = Date.now() - startTime;

      let markdown = '# Web Search Results\n\n';
      markdown += `**Searched:** ${queries.length} ${queriesText}\n`;
      markdown += `**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\n`;

      for (const qr of queryResults) {
        markdown += `## Query: ${qr.query}\n\n`;
        if (qr.error !== undefined) {
          const errorIcon = qr.error.type === 'empty_results' ? '📭' : '⚠️';
          markdown += `${errorIcon} **${qr.error.type === 'empty_results' ? 'No results' : 'Error'}:** ${qr.error.message}\n\n`;
          if (qr.error.type !== 'empty_results') {
            markdown += `**Error Type:** ${qr.error.type}\n\n`;
          }
        } else {
          markdown += `**Results:** ${qr.results.length} found\n\n`;
          for (let i = 0; i < Math.min(qr.results.length, maxResults); i++) {
            const result = qr.results[i];
            if (!result) continue;
            markdown += `### ${i + 1}. ${result.title}\n\n`;
            markdown += `- **URL:** ${result.url}\n`;
            if (result.content !== undefined) {
              const content = result.content;
              markdown += `- **Snippet:** ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}\n`;
            }
            markdown += '\n';
          }
          if (qr.results.length > maxResults) {
            const moreCount = qr.results.length - maxResults;
            const moreText = moreCount === 1 ? 'result' : 'results';
            markdown += `\n*... and ${moreCount} more ${moreText} not shown.*\n`;
          }
        }
        markdown += '\n---\n\n';
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: {
          queryResults,
          totalQueries: queries.length,
          totalResults: queryResults.reduce((sum, qr) => sum + qr.results.length, 0),
          duration: elapsed,
        },
      };
    },
  };
}

function isSearchParams(params: Record<string, unknown>): params is SearchParams {
  return (
    typeof params === 'object' &&
    params !== null &&
    'queries' in params &&
    Array.isArray(params['queries']) &&
    (params['queries'] as unknown[]).every((q: unknown) => typeof q === 'string')
  );
}
