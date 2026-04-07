/**
 * pi-research Extension
 *
 * Orchestrates multi-agent research using a state-driven swarm architecture.
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
      '\n\n### RESEARCH TOOL USAGE\nThe `research` tool (from pi-research) is for web/internet research ONLY. It is NOT for local code/file research.\n\n**CRITICAL INSTRUCTION: DEFAULT TO QUICK MODE.**\nYou MUST set `quick: true` for almost all research tasks. Only omit `quick: true` (entering deep swarm research) if you explicitly see words like "deep", "exhaustive", "comprehensive", "swarm", or "multi-agent", or if the situation\'s context warrants deep research. For all other general informative queries, ALWAYS use `quick: true`.';
    return { systemPrompt: event.systemPrompt + researchMessage };
  });

  logger.log('[pi-research] Extension loaded');
}
