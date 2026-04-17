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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load prompt from markdown file
 */
function loadPrompt(name: string): string {
  const path = join(__dirname, 'prompts', `${name}.md`);
  try {
    return readFileSync(path, 'utf-8');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[pi-research] Failed to load prompt from ${path}: ${msg}`);
    return '';
  }
}

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

  // Append research tool usage instructions to the system prompt
  pi.on('before_agent_start', async (event) => {
    const researchPrompt = loadPrompt('research-tool-usage');
    return {
      systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
    };
  });

  logger.log('[pi-research] Extension loaded');
}
