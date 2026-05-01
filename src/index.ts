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
        const { getConfig } = await import('./config.ts');
        const config = getConfig();
        
        // Directly invoke the research tool, bypassing the LLM entirely.
        // The tool handles its own TUI panel, progress tracking, and cleanup.
        const result = await researchTool.execute(
          randomUUID(),
          { query: text, depth: config.DEFAULT_RESEARCH_DEPTH },
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

  // /research-config — interactive configuration dashboard
  pi.registerCommand('research-config', {
    description: 'Interactive research configuration dashboard.',
    handler: async (_args, ctx) => {
      const { getConfig, validateConfig } = await import('./config.ts');
      const constants = await import('./constants.ts');
      const config = getConfig();

      const result = await ctx.ui.custom((_tui: any, theme: any, _keybindings: any, done: any) => {
          const content: any[] = [
              { type: 'text', text: '🔬 pi-research Configuration Dashboard', color: 'cyan' },
              { type: 'text', text: '═'.repeat(40), color: 'accent' },
              { type: 'text', text: ' [ Researchers ]', color: 'yellow' },
              { type: 'text', text: `  1. Max Concurrent:  ${config.MAX_CONCURRENT_RESEARCHERS.toString().padEnd(10)} (active slots)`, color: 'text' },
              { type: 'text', text: `  2. Timeout:        ${(config.RESEARCHER_TIMEOUT_MS / 1000).toString().padEnd(10)} (seconds)`, color: 'text' },
              { type: 'text', text: `  3. Max Retries:    ${config.RESEARCHER_MAX_RETRIES.toString().padEnd(10)} (per request)`, color: 'text' },
              { type: 'text', text: `  4. Default Depth:  ${config.DEFAULT_RESEARCH_DEPTH.toString().padEnd(10)} (for /research)`, color: 'text' },
              
              { type: 'text', text: '\n [ Context & Scraping ]', color: 'yellow' },
              { type: 'text', text: `  5. Scrape Limit:   ${Math.round(constants.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING * 100).toString().padEnd(10)} (% of context)`, color: 'text' },
              { type: 'text', text: `  6. Total Limit:    ${Math.round(constants.MAX_CONTEXT_FRACTION_FOR_SCRAPING * 100).toString().padEnd(10)} (% total budget)`, color: 'text' },
              { type: 'text', text: `  7. Avg Tokens:     ${constants.AVG_TOKENS_PER_SCRAPE.toString().padEnd(10)} (estimation)`, color: 'text' },

              { type: 'text', text: '\n [ TUI / UX ]', color: 'yellow' },
              { type: 'text', text: `  8. Refresh Rate:   ${config.TUI_REFRESH_DEBOUNCE_MS.toString().padEnd(10)} (ms debounce)`, color: 'text' },
              { type: 'text', text: `  9. Restore Delay:  ${(config.CONSOLE_RESTORE_DELAY_MS / 1000).toString().padEnd(10)} (seconds)`, color: 'text' },
              
              { type: 'text', text: '═'.repeat(40), color: 'accent' },
              { type: 'text', text: ' [1-9] Edit Setting | [Enter] Save | [Esc] Cancel', color: 'muted' },
          ];

          return {
              render: () => content.map(c => theme.fg(c.color, c.text)),
              invalidate: () => {},
              handleInput: async (key: string) => {
                  if (key === 'escape') {
                      done({ type: 'cancel' });
                  } else if (key === 'enter') {
                      done({ type: 'submit', data: config });
                  } else if (['1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(key)) {
                      const labels = [
                          'Max Concurrent Researchers', 'Researcher Timeout (s)', 'Max Retries',
                          'Default Research Depth (0-3)',
                          'Scrape Token Limit (%)', 'Total Context Limit (%)', 'Estimated Tokens per Scrape',
                          'TUI Refresh Rate (ms)', 'Console Restore Delay (s)'
                      ];
                      const idx = parseInt(key) - 1;
                      const val = await ctx.ui.input(`Edit ${labels[idx]}:`);
                      
                      if (val) {
                          const num = parseInt(val);
                          if (!isNaN(num)) {
                              switch(key) {
                                  case '1': config.MAX_CONCURRENT_RESEARCHERS = num; break;
                                  case '2': config.RESEARCHER_TIMEOUT_MS = num * 1000; break;
                                  case '3': config.RESEARCHER_MAX_RETRIES = num; break;
                                  case '4': config.DEFAULT_RESEARCH_DEPTH = num; break;
                                  case '5': (constants as any).MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING = num / 100; break;
                                  case '6': (constants as any).MAX_CONTEXT_FRACTION_FOR_SCRAPING = num / 100; break;
                                  case '7': (constants as any).AVG_TOKENS_PER_SCRAPE = num; break;
                                  case '8': config.TUI_REFRESH_DEBOUNCE_MS = num; break;
                                  case '9': config.CONSOLE_RESTORE_DELAY_MS = num * 1000; break;
                              }
                          }
                      }
                  }
              }
          };
      });

      if ((result as any).type === 'submit') {
          try {
              validateConfig(config);
              ctx.ui.notify('✅ Configuration updated', 'info');
              logger.info('[pi-research] Configuration updated via dashboard', config);
          } catch (e: any) {
              ctx.ui.notify(`❌ Invalid config: ${e.message}`, 'error');
          }
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
  pi.on('after_provider_response', async (event: any, ctx: any) => {
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
