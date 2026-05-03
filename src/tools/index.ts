/**
 * Tool Factory
 *
 * Creates all research tools with properly configured browser manager.
 * These tools are used by both direct tool calls and researcher agents.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { createReadTool } from '@mariozechner/pi-coding-agent';
import { createSearchTool } from './search.ts';
import { createScrapeTool } from './scrape.ts';
import { createLinksTool } from './links.ts';
import { createSecuritySearchTool } from './security.ts';
import { createStackexchangeTool } from './stackexchange.ts';
import { createGrepTool } from './grep.ts';

interface CreateToolsOptions {
  cwd: string;
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  /** Callback invoked when links are scraped (for real-time coordination) */
  onLinksScraped?: (links: string[]) => void;
  /** Callback invoked during search with cumulative link count found so far */
  onSearchProgress?: (links: number) => void;
}

/**
 * Create all research tools
 */
export function createResearchTools(options: CreateToolsOptions): ToolDefinition[] {
  // Create a fresh fallback state per tool instance to avoid state leakage between research runs
  const createFallbackState = (): SystemResearchState => ({
    version: 1,
    researchId: 'fallback',
    rootQuery: '',
    complexity: 1,
    currentRound: 1,
    status: 'researching',
    lastUpdated: Date.now(),
    initialAgenda: [],
    allScrapedLinks: [],
    aspects: {},
  });
  
  const fallbackState = createFallbackState();
  
  const resolvedOptions = {
    ...options,
    getGlobalState: options.getGlobalState ?? (() => fallbackState),
    updateGlobalLinks: options.updateGlobalLinks ?? ((links: string[]) => {
      fallbackState.allScrapedLinks = [...new Set([...fallbackState.allScrapedLinks, ...links])];
    }),
  };

  return [
    createReadTool(options.cwd),
    createSearchTool({
      ...resolvedOptions,
      onProgress: options.onSearchProgress,
    }),
    createScrapeTool({
      ...resolvedOptions,
      onLinksScraped: options.onLinksScraped,
    }),
    createLinksTool(resolvedOptions),
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
export { createLinksTool } from './links.ts';
export { createSecuritySearchTool } from './security.ts';
export { createStackexchangeTool } from './stackexchange.ts';
export { createGrepTool } from './grep.ts';
