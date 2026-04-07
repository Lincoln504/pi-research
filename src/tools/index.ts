/**
 * Tool Factory
 *
 * Creates all research tools with properly configured SearXNG URL.
 * These tools are used by both direct tool calls and researcher agents.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/swarm-types.ts';
import { createSearchTool } from './search.ts';
import { createScrapeTool } from './scrape.ts';
import { createSecuritySearchTool } from './security.ts';
import { createStackexchangeTool } from './stackexchange.ts';
import { createGrepTool } from './grep.ts';

interface CreateToolsOptions {
  searxngUrl: string;
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
}

/**
 * Create all research tools
 */
export function createResearchTools(options: CreateToolsOptions): ToolDefinition[] {
  const fallbackState: SystemResearchState = {
    version: 1,
    rootQuery: '',
    complexity: 1,
    currentRound: 1,
    status: 'researching',
    lastUpdated: Date.now(),
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {},
  };
  const resolvedOptions = {
    ...options,
    getGlobalState: options.getGlobalState ?? (() => fallbackState),
    updateGlobalLinks: options.updateGlobalLinks ?? ((links: string[]) => {
      fallbackState.allScrapedLinks = [...new Set([...fallbackState.allScrapedLinks, ...links])];
    }),
  };

  return [
    createSearchTool(resolvedOptions),
    createScrapeTool(resolvedOptions),
    createSecuritySearchTool(resolvedOptions),
    createStackexchangeTool(resolvedOptions),
    createGrepTool(resolvedOptions),
  ];
}

/**
 * Create individual tool exports for direct registration
 */
export { createSearchTool } from './search.ts';
export { createScrapeTool } from './scrape.ts';
export { createSecuritySearchTool } from './security.ts';
export { createStackexchangeTool } from './stackexchange.ts';
export { createGrepTool } from './grep.ts';
