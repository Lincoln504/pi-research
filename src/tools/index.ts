/**
 * Tool Factory
 *
 * Creates all research tools with properly configured browser manager.
 * These tools are used by both direct tool calls and researcher agents.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { ToolUsageTracker } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from '../orchestration/deep-research-types.ts';
import { createSearchTool } from './search.ts';
import { createScrapeTool } from './scrape.ts';
import { createLinksTool } from './links.ts';
import { createSecuritySearchTool } from './security.ts';
import { createStackexchangeTool } from './stackexchange.ts';
import { createGrepTool } from './grep.ts';

interface CreateToolsOptions {
  ctx: ExtensionContext;
  tracker: ToolUsageTracker;
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  /** Callback invoked when links are scraped (for real-time coordination) */
  onLinksScraped?: (links: string[]) => void;
  /** Returns tokens consumed by this researcher session so far (for context-aware scrape gating). */
  getTokensUsed?: () => number;
  /** Returns estimated scrape-specific tokens consumed by this researcher session so far. */
  getScrapeTokens?: () => number;
  /** Model context window size in tokens; defaults to DEFAULT_MODEL_CONTEXT_WINDOW. */
  contextWindowSize?: number;
}

/**
 * Create all research tools
 */
export function createResearchTools(options: CreateToolsOptions): ToolDefinition[] {
  // Create a fresh fallback state per tool instance to avoid state leakage between research runs
  const createFallbackState = (): SystemResearchState => ({
    version: 1,
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
    createSearchTool(resolvedOptions),
    createScrapeTool({
      ...resolvedOptions,
      onLinksScraped: options.onLinksScraped,
      getTokensUsed: options.getTokensUsed,
      getScrapeTokens: options.getScrapeTokens,
      contextWindowSize: options.contextWindowSize,
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
