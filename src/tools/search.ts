/**
 * search Tool
 *
 * Search the web via SearXNG and return URLs, titles, and snippets.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { search } from '../web-research/search.ts';
import type { SearxngSearchOptions } from '../web-research/types.ts';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';

interface SearchParams {
  queries: string[];
  maxResults?: number;
  freshness?: SearxngSearchOptions['freshness'];
  sourceType?: SearxngSearchOptions['sourceType'];
  [key: string]: unknown;
}

export function createSearchTool(options: {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
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
      'CRITICAL: You are allowed a maximum of 4 gathering calls total across ALL tools. Use them for breadth.',
      'Use sourceType "news" when researching current events, recent releases, or changelogs.',
      'Use sourceType "github" when looking for repositories, packages, or open-source libraries.',
      'Combine sourceType "news" with a freshness window (e.g. "week" or "month") for recent developments.',
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
      freshness: Type.Optional(Type.Union([
        Type.Literal('any'),
        Type.Literal('day'),
        Type.Literal('week'),
        Type.Literal('month'),
        Type.Literal('year'),
      ], {
        description: 'Restrict results to a time window. "any" (default) applies no filter. Use "week" or "month" for recent news or changelogs.',
      })),
      sourceType: Type.Optional(Type.Union([
        Type.Literal('general'),
        Type.Literal('news'),
        Type.Literal('github'),
      ], {
        description: 'Preferred source category. "general" (default) is broad web. "news" targets news sources. "github" searches the tech/code index (best for repos, packages, open-source).',
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _extensionCtx): Promise<AgentToolResult<unknown>> {
      // Record call in tracker - returns false if limit reached
      const allowed = options.tracker.recordCall('search');
      if (!allowed) {
        // THROW to prevent researcher from calling again
        throw new Error(options.tracker.getLimitMessage('search'));
      }

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
      const freshness = paramsRecord['freshness'] as SearxngSearchOptions['freshness'] | undefined;
      const sourceType = paramsRecord['sourceType'] as SearxngSearchOptions['sourceType'] | undefined;
      const searchOptions: SearxngSearchOptions = {
        ...(freshness && freshness !== 'any' ? { freshness } : {}),
        ...(sourceType ? { sourceType } : {}),
      };

      const queriesText = queries.length === 1 ? 'query' : 'queries';

      let queryResults;
      try {
        queryResults = await search(queries, searchOptions, signal);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const elapsed = Date.now() - startTime;
        return {
          content: [
            {
              type: 'text',
              text: `# Web Search Failed\n\n**Error:** ${errorMsg}\n\n**Queries Attempted:** ${queries.length}\n\n**Duration:** ${(elapsed / 1000).toFixed(2)}s\n\nFailed to search the web. This may be due to network issues, SearXNG unavailability, or search engine blocking.`,
            },
          ],
          details: {
            queries,
            error: errorMsg,
            duration: elapsed,
          },
        };
      }

      const elapsed = Date.now() - startTime;

      let markdown = '# Web Search Results\n\n';
      markdown += `**Searched:** ${queries.length} ${queriesText}\n`;
      markdown += `**Duration:** ${(elapsed / 1000).toFixed(2)}s\n`;
      if (sourceType && sourceType !== 'general') markdown += `**Source type:** ${sourceType}\n`;
      if (freshness && freshness !== 'any') markdown += `**Freshness filter:** ${freshness}\n`;
      markdown += '\n';

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

const VALID_FRESHNESS = new Set(['any', 'day', 'week', 'month', 'year']);
const VALID_SOURCE_TYPE = new Set(['general', 'news', 'github']);

function isSearchParams(params: Record<string, unknown>): params is SearchParams {
  if (
    typeof params !== 'object' ||
    params === null ||
    !('queries' in params) ||
    !Array.isArray(params['queries']) ||
    !(params['queries'] as unknown[]).every((q: unknown) => typeof q === 'string')
  ) {
    return false;
  }
  const freshness = params['freshness'];
  if (freshness !== undefined && !VALID_FRESHNESS.has(freshness as string)) return false;
  const sourceType = params['sourceType'];
  if (sourceType !== undefined && !VALID_SOURCE_TYPE.has(sourceType as string)) return false;
  return true;
}
