/**
 * stored_search Tool
 *
 * Query the local knowledge store for information across sessions.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { isKnowledgeStoreReady, getStore } from '../knowledge/index.ts';

export function createStoredSearchTool(_options: {
  ctx: ExtensionContext;
}): ToolDefinition {
  const StoredSearchParams = Type.Object({
    query: Type.String({ description: 'The search query' }),
    limit: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 20 })),
  });

  return {
    name: 'stored_search',
    label: 'Stored Search',
    description: 'Query the local knowledge store for information from previous research sessions.',
    promptSnippet: 'Search historical knowledge store',
    parameters: StoredSearchParams,
    async execute(_callId, params, _signal): Promise<AgentToolResult<unknown>> {
      if (!isKnowledgeStoreReady()) {
        return {
          content: [{ type: 'text', text: 'Knowledge store is initializing, try again shortly.' }],
          details: { status: 'initializing' },
        };
      }

      const p = params as Static<typeof StoredSearchParams>;
      const store = getStore();
      
      try {
        const results = await store.search(p.query, { limit: p.limit });
        
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No matching information found in the knowledge store.' }],
            details: { count: 0 },
          };
        }

        let markdown = `# Stored Search Results for "${p.query}"\n\n`;
        for (let i = 0; i < results.length; i++) {
          const res = results[i]!;
          markdown += `### ${res.url}\n`;
          markdown += `*Result ${i + 1} of ${results.length} (chunk ${res.metadata['chunkIndex'] + 1} of ${res.metadata['totalChunks']})*\n\n`;
          markdown += `${res.text}\n\n---\n\n`;
        }

        return {
          content: [{ type: 'text', text: markdown }],
          details: { count: results.length },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: 'search_failed' },
        };
      }
    },
  };
}
