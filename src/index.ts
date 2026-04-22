import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './tool.ts';
import { logger } from './logger.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadPrompt(name: string): string {
  try {
    const promptPath = join(__dirname, 'prompts', `${name}.md`);
    return readFileSync(promptPath, 'utf-8');
  } catch (err) {
    logger.error(`[pi-research] Failed to load prompt: ${name}`, err);
    return '';
  }
}

/**
 * Pi Research Extension
 */
export async function activate(pi: any, _ctx: ExtensionContext) {
  logger.log('[pi-research] Activating extension...');

  // Register research tool
  pi.registerTool(createResearchTool());

  // Append research tool usage instructions to the system prompt
  pi.on('before_agent_start', async (event: any) => {
    const researchPrompt = loadPrompt('research-tool-usage');
    return {
      systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
    };
  });

  logger.log('[pi-research] Extension loaded');
}
