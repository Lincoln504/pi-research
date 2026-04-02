/**
 * Tool Factory
 *
 * Creates all research tools with properly configured SearXNG URL.
 * These tools are used by both direct tool calls and researcher agents.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createPiSearchTool } from './pi-search.ts';
import { createPiScrapeTool } from './pi-scrape.ts';
import { createPiSecuritySearchTool } from './pi-security.ts';
import { createPiStackexchangeTool } from './pi-stackexchange.ts';
import { createGrepTool } from './grep.ts';

interface CreateToolsOptions {
  searxngUrl: string;
  ctx: ExtensionContext;
}

/**
 * Create all research tools
 */
export function createResearchTools(options: CreateToolsOptions): ToolDefinition[] {
  return [
    createPiSearchTool(options),
    createPiScrapeTool(options),
    createPiSecuritySearchTool(options),
    createPiStackexchangeTool(options),
    createGrepTool(),
  ];
}

/**
 * Create individual tool exports for direct registration
 */
export { createPiSearchTool } from './pi-search.js';
export { createPiScrapeTool } from './pi-scrape.js';
export { createPiSecuritySearchTool } from './pi-security.js';
export { createPiStackexchangeTool } from './pi-stackexchange.js';
export { createGrepTool } from './grep.js';
