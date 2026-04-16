/**
 * pi-research Extension
 *
 * Orchestrates multi-agent research using a state-driven deep mode architecture.
 * Manages SearXNG as singleton (shared across all agents).
 * SearXNG is initialized on first research() call, NOT on session_start.
 * Extension-owned cleanup is delegated to pi's session lifecycle.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './src/tool.ts';
import { logger, isVerboseFromEnv, getDefaultDebugLogPathTemplate } from './src/logger.ts';
import { checkDockerAvailability } from './src/infrastructure/searxng-lifecycle.ts';
import { shutdownManager } from './src/utils/shutdown-manager.ts';

export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Extension loading...');

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
    const researchMessage = [
      '',
      '',
      '### RESEARCH TOOL USAGE',
      'The `research` tool (from pi-research) is for web/internet research ONLY. It is NOT for local code/file research.',
      '',
      '**DEPTH PARAMETER — use this to control research intensity:**',
      '- `depth: "brief"`  — single researcher, fastest. Use for quick lookups.',
      '- `depth: "normal"` — 1-2 researchers, up to 2 rounds. Use for standard queries.',
      '- `depth: "deep"`   — 2-3 researchers, up to 3 rounds. Use for thorough investigation.',
      '- `depth: "ultra"`  — 3 researchers, up to 3 rounds (maximum). Use for exhaustive search.',
      '- (omit depth)      — auto-assess; defaults to quick for simple queries, deep for complex ones.',
      '',
      '**CRITICAL INSTRUCTION: DEFAULT TO BRIEF.**',
      'When depth is not specified by the user, set `depth: "brief"` for most queries.',
      'Only use deep/ultra when the user explicitly requests thoroughness.',
      'When the user asks to research multiple topics at different depths in one message, call `research` once per topic with the appropriate `depth` value.',
    ].join('\n');
    return { systemPrompt: event.systemPrompt + researchMessage };
  });

  logger.log('[pi-research] Extension loaded');
}
