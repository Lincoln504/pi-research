/**
 * pi-research Extension
 *
 * Orchestrates multi-agent research using a coordinator + parallel/sequential researcher architecture.
 * Manages SearXNG as singleton (shared across all agents).
 * SearXNG is initialized on first research() call, NOT on session_start.
 * SearXNG lives for the lifetime of the pi process (no session-based shutdown).
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './src/tool.js';

export default function (pi: ExtensionAPI) {
  console.log('[pi-research] Extension loading...');

  // NOTE: SearXNG lifecycle is managed independently of sessions
  // Container lives for the duration of the pi process
  // No session_shutdown or session_switch handlers needed
  // SearXNG is initialized on first research() call in tool.ts

  // Register research tool
  pi.registerTool(createResearchTool());

  console.log('[pi-research] Extension loaded');
}
