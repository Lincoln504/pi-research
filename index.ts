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
      '- `depth: 0` (Quick/Brief) — 1 researcher, 1 round. Fastest; use for simple questions or focused lookups.',
      '- `depth: 1` (Normal) — 2 initial researchers, up to 2 rounds. Best for standard topics.',
      '- `depth: 2` (Deep) — 3 initial researchers, up to 3 rounds. Best for nuanced or complex topics.',
      '- `depth: 3` (Ultra) — 5 initial researchers, up to 5 rounds. Exhaustive; use for high-stakes or multi-dimensional queries.',
      '- (omit depth) — defaults to `0` (Quick) for most queries.',
      '',
      '**CRITICAL INSTRUCTION: DEFAULT TO DEPTH 0.**',
      'When depth is not specified by the user, set `depth: 0` for most queries.',
      'Only use higher depths when the user explicitly requests thoroughness or the topic is complex.',
      '',
      '**CRITICAL: Choosing Depth.** Higher depth takes significantly more time and cost. Judgement criteria:',
      '• Use `0` if the answer likely resides in 1-2 sources.',
      '• Use `1` for balanced overviews (e.g. "pros and cons of X").',
      '• Use `2` or `3` only when the user explicitly asks for "exhaustive", "deep-dive", "ultra", or "comprehensive" research.',
      '',
      '**Note for Coordinator:** The system automatically maps the provided depth to the researcher swarm; your job is to take the assigned depth and decompose the query into the best possible research agenda.',
    ].join('\n');
    return { systemPrompt: event.systemPrompt + researchMessage };
  });

  logger.log('[pi-research] Extension loaded');
}
