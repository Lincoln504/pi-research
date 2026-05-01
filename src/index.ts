import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { createResearchTool } from './tool.ts';
import { logger } from './logger.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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

// Extract the text content from a research tool result
function extractResultText(result: AgentToolResult<unknown>): string {
  const textBlock = result.content?.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );
  return textBlock?.text || 'Research completed, but no text content was generated.';
}

/**
 * Pi Research Extension
 */
export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Activating extension...');

  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool();
  pi.registerTool(researchTool);

  // /research <query> — direct quick research, no LLM turn.
  pi.registerCommand('research', {
    description: 'Quick web research.',
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) return;

      try {
        // Directly invoke the research tool, bypassing the LLM entirely.
        // The tool handles its own TUI panel, progress tracking, and cleanup.
        const result = await researchTool.execute(
          randomUUID(),
          { query: text },
          ctx.signal,
          undefined,
          ctx as any,
        );

        const output = extractResultText(result);

        // Inject result as a custom message — no agent turn triggered.
        pi.sendMessage({
          customType: 'research-result',
          content: output,
          display: true,
          details: { totalTokens: (result.details as any)?.totalTokens ?? 0 },
        });

        ctx.ui.notify('✅ Research complete', 'info');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[pi-research] /research command failed:', error);

        pi.sendMessage({
          customType: 'research-result',
          content: `**Research failed**\n\n${message}`,
          display: true,
          details: { error: message },
        });

        ctx.ui.notify(`❌ Research failed: ${message}`, 'error');
      }
    },
  });

  // /research-reload — hot reload the pi-research extension
  pi.registerCommand('research-reload', {
    description: 'Reload pi-research extension (hot reload config changes)',
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify('🔄 Reloading pi-research...', 'info');
        
        // Use Pi's reload function if available
        if (typeof ctx.reload === 'function') {
          await ctx.reload();
          ctx.ui.notify('✅ pi-research reloaded successfully', 'info');
        } else {
          // Fallback: notify user that reload is not available
          ctx.ui.notify('⚠️ Hot reload not available - restart Pi to reload', 'warning');
          logger.warn('[pi-research] ctx.reload() not available in this Pi version');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[pi-research] /research-reload failed:', error);
        ctx.ui.notify(`❌ Reload failed: ${message}`, 'error');
      }
    },
  });

  // Append research tool usage instructions to the system prompt
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const researchPrompt = loadPrompt('research-tool-usage');
    
    // Check if this is a researcher session by examining the model ID or system prompt
    const isResearcher = ctx?.model?.id?.toLowerCase().includes('researcher') ||
                        event.systemPrompt?.toLowerCase().includes('researcher');

    if (isResearcher) {
      // Add researcher-specific guidelines for better research quality
      const researcherGuidelines = `

## Research Guidelines (Auto-Injected)

- **Focus on Evidence**: Gather facts and evidence from reliable sources
- **Avoid Speculation**: Only report what sources explicitly confirm
- **Cite Sources**: Explicitly cite sources when making claims
- **Flag Uncertainty**: Mark information as uncertain when sources disagree
- **Be Thorough**: Use the full tool budget for comprehensive coverage
- **Stay Focused**: Maintain focus on the assigned research goal
`;
      return {
        systemPrompt: event.systemPrompt + '\n\n' + researchPrompt + researcherGuidelines
      };
    }

    return {
      systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
    };
  });

  // Monitor provider responses for diagnostics
  pi.on('after_provider_response', (event: any, ctx: any) => {
    const { status, headers } = event;

    // Log provider status for diagnostics
    if (status >= 500) {
      logger.warn(`[pi-research] Provider server error: ${status}`, { headers });
    } else if (status === 429) {
      const retryAfter = headers?.['retry-after'];
      logger.warn(`[pi-research] Rate limited by provider`, { retryAfter });
      if (retryAfter) {
        ctx.ui?.notify?.(`Rate limited. Retry after ${retryAfter}s`, 'warning');
      }
    } else if (status >= 400) {
      logger.warn(`[pi-research] Provider error: ${status}`, { headers });
    }
  });

  logger.log('[pi-research] Extension loaded');
}
