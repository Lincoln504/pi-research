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
import { logger, suppressConsole, isVerboseFromEnv } from './src/logger.js';

export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Extension loading...');

  // Suppress console output globally (catches third-party modules like SearXNG).
  // Pi's TUI doesn't use console.* directly, so this is safe for the entire session.
  suppressConsole();

  // NOTE: SearXNG lifecycle is managed independently of sessions
  // Container lives for the duration of the pi process
  // No session_shutdown or session_switch handlers needed
  // SearXNG is initialized on first research() call in tool.ts

  // Notify user of log file location when starting a new session (verbose mode only)
  pi.on('session_start', (_event, ctx) => {
    if (isVerboseFromEnv()) {
      ctx.ui.notify('pi-research: debug log → /tmp/pi-research-debug.log', 'info');
    }
  });

  // Register research tool
  pi.registerTool(createResearchTool());

  logger.log('[pi-research] Extension loaded');
}
