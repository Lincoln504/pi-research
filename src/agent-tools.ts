/**
 * Agent Tools
 *
 * Creates tools for researcher agents.
 * All functionality is now internal - no external imports.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createSearchTool } from './tools/search.js';
import { createScrapeTool } from './tools/scrape.js';
import { createSecuritySearchTool } from './tools/security.js';
import { createStackexchangeTool } from './tools/stackexchange.js';
import { createGrepTool } from './tools/grep.js';

interface CreateAgentToolsOptions {
  searxngUrl: string;
  ctx: ExtensionContext;
}

/**
 * Create all agent tools for researcher agents
 */
export function createAgentTools(options: CreateAgentToolsOptions): ToolDefinition[] {
  // Set SearXNG URL for internal modules
  // Note: SearxngManager is set by tool.ts during session startup
  // We just need to ensure the URL is available via getSearxngUrl()

  return [
    createSearchTool(options),
    createScrapeTool(options),
    createSecuritySearchTool(options),
    createStackexchangeTool(options),
    createGrepTool(),
  ];
}

// Export individual tool factory functions
export { createSearchTool } from './tools/search.js';
export { createScrapeTool } from './tools/scrape.js';
export { createSecuritySearchTool } from './tools/security.js';
export { createStackexchangeTool } from './tools/stackexchange.js';
export { createGrepTool } from './tools/grep.js';
