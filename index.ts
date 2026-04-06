/**
 * pi-research Extension
 *
 * Orchestrates multi-agent research using a coordinator + parallel/sequential researcher architecture.
 * Manages SearXNG as singleton (shared across all agents).
 * SearXNG is initialized on first research() call, NOT on session_start.
 * Extension-owned cleanup is delegated to pi's session lifecycle.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './src/tool.ts';
import { logger, suppressConsole, isVerboseFromEnv, getDefaultDebugLogPathTemplate } from './src/logger.ts';
import { checkDockerAvailability } from './src/infrastructure/searxng-lifecycle.ts';
import { shutdownManager } from './src/utils/shutdown-manager.ts';

export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Extension loading...');

  // Suppress console output globally (catches third-party modules like SearXNG).
  // Pi's TUI doesn't use console.* directly, so this is safe for the entire session.
  suppressConsole();

  // NOTE: SearXNG is still initialized lazily on first research() call in tool.ts.
  // Cleanup runs on pi's session lifecycle instead of owning host process signals.

  pi.on('session_shutdown', async (_event, _ctx) => {
    await shutdownManager.runCleanup('session_shutdown');
  });

  // Notify user of Docker status and log file location when starting a new session
  pi.on('session_start', async (_event, ctx) => {
    // Check Docker availability on startup
    const dockerCheck = await checkDockerAvailability();
    if (!dockerCheck.running) {
      ctx.ui.notify(`pi-research: ${dockerCheck.error}`, 'warning');
    }

    if (isVerboseFromEnv()) {
      ctx.ui.notify(`pi-research: debug log → ${getDefaultDebugLogPathTemplate()}`, 'info');
    }
  });

  // Register research tool
  pi.registerTool(createResearchTool());

  // Append a usage message to the system prompt for the main chat
  pi.on('before_agent_start', async (event) => {
    const researchMessage =
      '\n\nThe `research` tool (from pi-research) is specifically for web/internet research. It is NOT for local file examination or local on-disk context gathering/research. It accepts a `query`, an optional `model` (defaults to your current model), and an optional `quick` parameter for straightforward factual lookups. For normal research (no `quick` option), ensure the `query` precisely reflects the necessary depth (or lack thereof), specificity, and scope (whether broad, nuanced, or both) as demanded by the task. If a research task is judged to be on the simpler side, favor the `quick` research mode.';
    return { systemPrompt: event.systemPrompt + researchMessage };
  });

  logger.log('[pi-research] Extension loaded');
}
