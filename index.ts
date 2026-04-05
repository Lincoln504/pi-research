/**
 * pi-research Extension
 *
 * Orchestrates multi-agent research using a coordinator + parallel/sequential researcher architecture.
 * Manages SearXNG as singleton (shared across all agents).
 * SearXNG is initialized on first research() call, NOT on session_start.
 * SearXNG lives for the lifetime of the pi process (no session-based shutdown).
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './src/tool.ts';
import { logger, suppressConsole, isVerboseFromEnv } from './src/logger.ts';
import { checkDockerAvailability } from './src/infrastructure/searxng-lifecycle.ts';

export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Extension loading...');

  // Suppress console output globally (catches third-party modules like SearXNG).
  // Pi's TUI doesn't use console.* directly, so this is safe for the entire session.
  suppressConsole();

  // NOTE: SearXNG lifecycle is managed independently of sessions
  // Container lives for the duration of the pi process
  // No session_shutdown or session_switch handlers needed
  // SearXNG is initialized on first research() call in tool.ts

  // Notify user of Docker status and log file location when starting a new session
  pi.on('session_start', async (_event, ctx) => {
    // Check Docker availability on startup
    const dockerCheck = await checkDockerAvailability();
    if (!dockerCheck.running) {
      ctx.ui.notify(`pi-research: ${dockerCheck.error}`, 'warning');
    }

    if (isVerboseFromEnv()) {
      ctx.ui.notify('pi-research: debug log → /tmp/pi-research-debug.log', 'info');
    }
  });

  // Register research tool
  pi.registerTool(createResearchTool());

  logger.log('[pi-research] Extension loaded');
}
