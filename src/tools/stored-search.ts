/**
 * stored_search Tool
 *
 * Query the local knowledge store for information across sessions.
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { getConfig } from '../config.ts';
import { logger } from '../logger.ts';

export function createStoredSearchTool(_options: {
  ctx: ExtensionContext;
}): ToolDefinition {
  const StoredSearchParamsSchema = Type.Object({
    query: Type.String({ description: 'The search query' }),
    limit: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 20 })),
  });

  type StoredSearchParams = Static<typeof StoredSearchParamsSchema>;

  return {
    name: 'stored_search',
    label: 'Stored Search',
    description: 'Query the local knowledge store for summaries of findings from previous research sessions. Use this for discovery and to find URLs that were relevant in the past.',
    promptSnippet: 'Search historical knowledge store for summaries',
    parameters: StoredSearchParamsSchema,
    executionMode: 'parallel',
    async execute(_callId: string, params: unknown, _signal: AbortSignal): Promise<AgentToolResult<unknown>> {
      if (!Value.Check(StoredSearchParamsSchema, params)) {
        return {
          content: [{ type: 'text', text: 'Invalid parameters for stored_search.' }],
          details: { error: 'invalid_params' },
        };
      }

      const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);

      if (!service.isReady()) {
        const config = getConfig();
        if (config.KNOWLEDGE_STORE_ENABLED) {
          // Trigger lazy initialization in background
          const initPromise = service.initialize?.();
          if (initPromise) {
            initPromise.catch(err => {
              logger.warn('[stored-search] Background knowledge store initialization failed:', err);
            });
          }
          return {
            content: [{ type: 'text', text: 'Knowledge store is initializing, try again shortly.' }],
            details: { status: 'initializing' },
          };
        } else {
           return {
            content: [{ type: 'text', text: 'Knowledge store is disabled in settings.' }],
            details: { error: 'disabled' },
          };
        }
      }

      const p = params as StoredSearchParams;
      
      try {
        const store = await service.getStore();
        const results = await store.search(p.query, { limit: p.limit });
        
        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No matching information found in the knowledge store.' }],
            details: { count: 0 },
          };
        }

        let markdown = `# Stored Search Results for "${p.query}"\n\n`;
        markdown += `**Source: Knowledge Store (Historical Search)**\n\n`;
        for (let i = 0; i < results.length; i++) {
          const res = results[i]!;
          const chunkIndex = res.metadata['chunkIndex'];
          const totalChunks = res.metadata['totalChunks'];
          const chunkLabel = typeof chunkIndex === 'number' && typeof totalChunks === 'number'
            ? ` (chunk ${chunkIndex + 1} of ${totalChunks})`
            : '';
          markdown += `### ${res.url}\n`;
          const sourceOrigin = res.metadata['sourceOrigin'];
          if (sourceOrigin) {
            markdown += `**Original Source:** ${sourceOrigin}\n`;
          }
          markdown += `*Result ${i + 1} of ${results.length}${chunkLabel}*\n\n`;
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
