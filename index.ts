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
      '### 🔍 RESEARCH TOOL USAGE',
      '',
      '**For any web/internet research questions, use the `research` tool.**',
      '',
      'The `research` tool (from pi-research extension) is your tool for web/internet research.',
      '',
      '**What counts as web research?**',
      '- Questions requiring current information (news, trends, latest developments)',
      '- Questions about products, services, companies',
      '- Questions requiring statistics or data',
      '- Questions about people, places, events, or topics external to this project',
      '- "What is X?", "How does X work?", "Tell me about X" questions',
      '',
      '**What is NOT web research (use other tools for these):**',
      '- Reading files in the project (use `read` tool)',
      '- Running commands or tests (use `bash` tool)',
      '- Analyzing code in this repository',
      '- Questions about the project itself',
      '',
      '---',
      '',
      '**DEPTH PARAMETER — controls research intensity:**',
      '',
      '**DEFAULT: Omit depth parameter** (uses `depth: 0` - Quick mode)',
      '- 1 researcher, 1 round. Fastest for most queries.',
      '',
      '**Higher depths (only when user requests thoroughness):**',
      '- `depth: 1` — Normal: 2 researchers, up to 2 rounds',
      '- `depth: 2` — Deep: 3 researchers, up to 3 rounds',
      '- `depth: 3` — Ultra: 5 researchers, up to 5 rounds',
      '',
      '**Key rule: Default to depth 0. Use higher depths when user explicitly asks for "exhaustive", "deep-dive", "ultra", or "comprehensive" research.**',
    ].join('\n');
    return { systemPrompt: event.systemPrompt + researchMessage };
  });

  logger.log('[pi-research] Extension loaded');
}
