/**
 * links Tool
 *
 * Query the global shared links pool and discovered evidence.
 * Allows researchers to see what has already been found/scraped.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { getScrapedLinks } from '../utils/shared-links.ts';

export function createLinksTool(options: {
  ctx: ExtensionContext;
  getGlobalState: () => SystemResearchState;
}): ToolDefinition {

  const LinksParamsSchema = Type.Object({
    action: Type.Union([Type.Literal('list'), Type.Literal('search')], { 
        description: 'Action to perform: "list" all scraped links or "search" for specific keywords in URLs.' 
    }),
    query: Type.Optional(Type.String({
        description: 'Keyword to search for in the URL pool (required for "search" action).'
    })),
  });

  type LinksParams = Static<typeof LinksParamsSchema>;

  return {
    name: 'links',
    label: 'Links',
    description: 'Query the global shared links pool and discovered evidence.',
    promptSnippet: 'Check already scraped links or discovered evidence',
    promptGuidelines: [
      'Use this tool to see what other researchers have already found or scraped.',
      'Prevents redundant work by identifying overlapping sources.',
      'Does NOT cost a gathering or scrape call.',
    ],
    parameters: LinksParamsSchema,
    executionMode: 'parallel',
    async execute(_callId, params): Promise<AgentToolResult<unknown>> {
      if (!Value.Check(LinksParamsSchema, params)) {
          return {
            content: [{ type: 'text', text: 'Invalid parameters for links tool.' }],
            details: { error: 'invalid_parameters' },
          };
      }

      const p = params as LinksParams;
      const action = p.action;
      const query = (p.query || '').toLowerCase();
      
      const state = options.getGlobalState();
      const researchId = state.researchId; 
      const links = getScrapedLinks(researchId);

      let filtered = links;
      if (action === 'search' && query) {
          filtered = links.filter(l => l.toLowerCase().includes(query));
      }

      let markdown = `# Global Scraped Links (${filtered.length} found)\n\n`;
      if (filtered.length === 0) {
          markdown += `*No links found ${query ? `matching "${query}"` : 'in the pool'}.*`;
      } else {
          filtered.forEach((l, i) => {
              markdown += `${i + 1}. ${l}\n`;
          });
      }

      return {
        content: [{ type: 'text', text: markdown }],
        details: { count: filtered.length, action },
      };
    },
  };
}
