/**
 * pi-research: Multi-Agent Research Orchestration Tool
 *
 * This is the primary entry point for the pi-research extension. It provides:
 * - Research tool: Web/internet research with multi-agent orchestration
 * - Health tool: System health checks across all components
 *
 * Tool definitions are modularized into:
 * - tools/research-tool-definition.ts - Main research tool logic
 * - tools/health-tool-definition.ts - Health check tool logic
 * - tui/research-tui-manager.ts - TUI coordination
 * - observers/research-observer-impl.ts - Research lifecycle observer
 * - cleanup/research-cleanup.ts - Session cleanup logic
 * - utils/research-health.ts - Health check helpers
 * - utils/pi-session.ts - PI session metadata helpers
 */

import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './tools/research-tool-definition.ts';
import { createHealthTool } from './tools/health-tool-definition.ts';

/**
 * Get all tool definitions provided by pi-research
 */
export function getToolDefinitions(): ToolDefinition[] {
  return [
    createResearchTool(),
    createHealthTool(),
  ];
}

/**
 * Export individual tool creation functions for direct use
 */
export { createResearchTool } from './tools/research-tool-definition.ts';
export { createHealthTool } from './tools/health-tool-definition.ts';