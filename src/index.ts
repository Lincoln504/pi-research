import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
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
export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Activating extension...');

  // Register research tool
  pi.registerTool(createResearchTool());

  // /research [--deep|-d] <query>
  // Without a flag: quick research (depth 0, agent default).
  // With --deep/-d:  deep multi-round research; the word "deep" in the message
  //                  causes the agent to skip quick mode per the system prompt.
  pi.registerCommand('research', {
    description: 'Research a topic on the web. Use --deep or -d for multi-round deep research.',
    handler: async (args) => {
      let text = args.trim();
      if (!text) return;

      const deep = /(?:^|\s)(--deep|-d)(?:\s|$)/.test(text);
      text = text.replace(/(?:^|\s)(--deep|-d)(?:\s|$)/g, ' ').trim();
      if (!text) return;

      pi.sendUserMessage(deep ? `Deep research: ${text}` : `Research: ${text}`);
    },
  });

  // Append research tool usage instructions to the system prompt
  pi.on('before_agent_start', async (event: any) => {
    const researchPrompt = loadPrompt('research-tool-usage');
    return {
      systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
    };
  });

  logger.log('[pi-research] Extension loaded');
}
