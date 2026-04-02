/**
 * Agent Tools
 *
 * Creates tools for researcher agents.
 * All functionality is now internal - no external imports.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createPiSearchTool } from './tools/pi-search.js';
import { createPiScrapeTool } from './tools/pi-scrape.js';
import { createPiSecuritySearchTool } from './tools/pi-security.js';
import { createPiStackexchangeTool } from './tools/pi-stackexchange.js';
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
    createPiSearchTool(options),
    createPiScrapeTool(options),
    createPiSecuritySearchTool(options),
    createPiStackexchangeTool(options),
    createGrepTool(),
  ];
}

// Export individual tool factory functions
export { createPiSearchTool } from './tools/pi-search.js';
export { createPiScrapeTool } from './tools/pi-scrape.js';
export { createPiSecuritySearchTool } from './tools/pi-security.js';
export { createPiStackexchangeTool } from './tools/pi-stackexchange.js';
export { createGrepTool } from './tools/grep.js';
