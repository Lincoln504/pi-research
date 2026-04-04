/**
 * Tool Factory
 *
 * Creates all research tools with properly configured SearXNG URL.
 * These tools are used by both direct tool calls and researcher agents.
 */

import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createSearchTool } from './search.js';
import { createScrapeTool } from './scrape.js';
import { createSecuritySearchTool } from './security.js';
import { createStackexchangeTool } from './stackexchange.js';
import { createGrepTool } from './grep.js';

interface CreateToolsOptions {
  searxngUrl: string;
  ctx: ExtensionContext;
}

/**
 * Create all research tools
 */
export function createResearchTools(options: CreateToolsOptions): ToolDefinition[] {
  return [
    createSearchTool(options),
    createScrapeTool(options),
    createSecuritySearchTool(options),
    createStackexchangeTool(options),
    createGrepTool(),
  ];
}

/**
 * Create individual tool exports for direct registration
 */
export { createSearchTool } from './search.js';
export { createScrapeTool } from './scrape.js';
export { createSecuritySearchTool } from './security.js';
export { createStackexchangeTool } from './stackexchange.js';
export { createGrepTool } from './grep.js';
