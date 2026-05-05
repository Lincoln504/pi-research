import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import { createResearchTool } from './tool.ts';
import { logger } from './logger.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { shutdownManager } from './utils/shutdown-manager.ts';

// Modular Orchestration Exports
export { runResearch, type ResearchOptions } from './orchestration/research-manager.ts';
export { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
export { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
export { shutdownManager } from './utils/shutdown-manager.ts';
export type { ResearchObserver } from './orchestration/research-observer.ts';
export { normalizeUrl } from './utils/shared-links.ts';
export { resetConfig, getConfig, setConfig } from './config.ts';

import {
  MAX_TEAM_SIZE_LEVEL_1,
  MAX_TEAM_SIZE_LEVEL_2,
  MAX_TEAM_SIZE_LEVEL_3,
} from './constants.ts';

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

  // Ensure background resources like browser pools are cleaned up
  const handleShutdown = (signal: string) => {
    logger.log(`[pi-research] Received ${signal}, initiating cleanup...`);
    shutdownManager.runCleanup(signal)
      .then(() => process.exit(0))
      .catch(err => {
        logger.error(`[pi-research] ${signal} cleanup failed:`, err);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGHUP', () => handleShutdown('SIGHUP'));

  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool();
  pi.registerTool(researchTool);

  // /research <query> — direct quick research, no LLM turn.
  pi.registerCommand('research', {
    description: 'Web research a query',
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

  // /research-config — interactive configuration dashboard
  pi.registerCommand('research-config', {
    description: 'Research Configuration TUI',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('Research Configuration TUI requires interactive mode', 'error');
        return;
      }

      const { getConfig, validateConfig, saveConfig, resetConfig, getEnvFilePath } = await import('./config.ts');
      const config = { ...getConfig() }; // Work on a copy

      // Get .env file location for help text
      const envFilePath = getEnvFilePath();
      // Make the path more user-friendly by using ~ for home directory
      const homeDir = process.env['HOME'] || '';
      const displayEnvPath = envFilePath.startsWith(homeDir) 
        ? envFilePath.replace(homeDir, '~') 
        : envFilePath;

      // Define configuration items with their bounds, step values, and formatters
      type ConfigKey = keyof typeof config;
      interface ConfigItem {
        key: ConfigKey;
        label: string;
        description: string;
        min: number;
        max: number;
        step: number;
        displayMin: number;  // Display value for min (different units)
        displayMax: number;  // Display value for max (different units)
        toDisplay: (value: number) => number;  // Convert stored value to display value
        fromDisplay: (display: number) => number;  // Convert display value to stored value
        format: (value: number) => string;
      }

      const configItems: ConfigItem[] = [
        {
          key: 'MAX_CONCURRENT_RESEARCHERS',
          label: 'Max Concurrent',
          description: '(Researchers)',
          min: 1,
          max: 5,
          displayMin: 1,
          displayMax: 5,
          step: 1,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          key: 'DEFAULT_RESEARCH_DEPTH',
          label: 'Default Depth',
          description: '(0=quick 1-3=deep)',
          min: 0,
          max: 3,
          displayMin: 0,
          displayMax: 3,
          step: 1,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          key: 'RESEARCHER_TIMEOUT_MS',
          label: 'Researcher Timeout',
          description: '(3-30 min)',
          min: 180000,   // Stored in milliseconds (3 min = 180000ms)
          max: 1800000,  // Stored in milliseconds (30 min = 1800000ms)
          displayMin: 180,   // Displayed in seconds (3 min)
          displayMax: 1800,  // Displayed in seconds (30 min)
          step: 30,  // Adjust in 30 second increments (display units = seconds)
          toDisplay: (v) => v / 1000,  // ms to seconds
          fromDisplay: (v) => v * 1000,  // seconds to ms
          format: (v) => `${v}s`,
        },
        {
          key: 'WORKER_THREADS',
          label: 'Worker Threads',
          description: '(Playwright Search)',
          min: 1,
          max: 16,
          displayMin: 1,
          displayMax: 16,
          step: 1,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          key: 'MAX_SCRAPE_BATCHES',
          label: 'Max Scrape Batches',
          description: '(1-16, Unlimited)',
          min: 0,
          max: 16,
          displayMin: 0,
          displayMax: 16,
          step: 1,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => v === 0 ? 'Unlimited' : v.toString(),
        },
      ];

      // Use ctx.ui.custom() to create a proper TUI component
      const result = await ctx.ui.custom<{ type: string; data?: typeof config } | undefined>(
        (tui, theme, _kb, done) => {
          // TUI Component class for configuration dashboard
          class ConfigDashboardComponent {
            private selectedIndex: number;
            private cachedLines: string[] = [];
            private cachedWidth = 0;
            private cachedVersion = -1;
            private version = 0;

            constructor() {
              this.selectedIndex = 0; // Start on first item (Max Concurrent)
            }

            render(width: number): string[] {
              // Check cache
              if (this.cachedWidth === width && this.cachedVersion === this.version) {
                return this.cachedLines;
              }

              const sep = theme.fg('accent', '─'.repeat(Math.max(0, width - 2)));
              const lines = [theme.fg('accent', ' pi-research Configuration'), sep];

              configItems.forEach((item, idx) => {
                const value = config[item.key] as number;
                const displayValue = item.format(item.toDisplay(value));
                const isSelected = idx === this.selectedIndex;
                const prefix = isSelected ? theme.fg('accent', '► ') : '  ';
                const valueDisplay = isSelected
                  ? theme.fg('accent', displayValue.padStart(6))
                  : displayValue.padStart(6);
                lines.push(theme.fg('text', `${prefix}${item.label.padEnd(20)} ${valueDisplay} ${item.description}`));
              });

              lines.push(sep);
              lines.push(theme.fg('muted', ' ↑↓ Navigate  ←→ Adjust  [Enter] Save  [Esc] Cancel'));
              lines.push(theme.fg('muted', ` Additional configuration options found in ${displayEnvPath}`));

              // Truncate lines to fit within width
              this.cachedLines = lines.map(line => {
                const lw = visibleWidth(line);
                return lw > width ? truncateToWidth(line, Math.max(1, width)) : line;
              });
              this.cachedWidth = width;
              this.cachedVersion = this.version;

              return this.cachedLines;
            }

            handleInput(key: string): void {
              // Escape - cancel (must check before arrow keys, matchesKey properly distinguishes)
              if (matchesKey(key, 'escape')) {
                done({ type: 'cancel' });
                return;
              }

              // Enter - save (handle both CR and LF)
              if (key === '\r' || key === '\n') {
                done({ type: 'submit', data: config });
                return;
              }

              // Up arrow - move selection up (wraps to bottom)
              if (matchesKey(key, 'up')) {
                this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : configItems.length - 1;
                this.version++;
                tui.requestRender();
                return;
              }

              // Down arrow - move selection down (wraps to top)
              if (matchesKey(key, 'down')) {
                this.selectedIndex = this.selectedIndex < configItems.length - 1 ? this.selectedIndex + 1 : 0;
                this.version++;
                tui.requestRender();
                return;
              }

              // Left arrow - decrease value
              if (matchesKey(key, 'left')) {
                const item = configItems[this.selectedIndex];
                if (!item) return;
                const currentValue = config[item.key] as number;
                const currentDisplay = item.toDisplay(currentValue);
                const newDisplay = Math.max(item.displayMin, currentDisplay - item.step);
                const newValue = item.fromDisplay(newDisplay);
                if (newValue !== currentValue) {
                  (config[item.key] as any) = newValue;
                  this.version++;
                  tui.requestRender();
                }
                return;
              }

              // Right arrow - increase value
              if (matchesKey(key, 'right')) {
                const item = configItems[this.selectedIndex];
                if (!item) return;
                const currentValue = config[item.key] as number;
                const currentDisplay = item.toDisplay(currentValue);
                const newDisplay = Math.min(item.displayMax, currentDisplay + item.step);
                const newValue = item.fromDisplay(newDisplay);
                if (newValue !== currentValue) {
                  (config[item.key] as any) = newValue;
                  this.version++;
                  tui.requestRender();
                }
                return;
              }
            }

            invalidate(): void {
              this.cachedVersion = -1;
            }
          }

          return new ConfigDashboardComponent();
        },
      );

      if (result && result.type === 'submit' && result.data) {
        try {
          validateConfig(result.data);
          saveConfig(result.data);
          resetConfig();
          ctx.ui.notify('Configuration updated and saved', 'info');
          logger.info('[pi-research] Configuration updated via dashboard', result.data);
        } catch (e: any) {
          ctx.ui.notify(`Invalid config: ${e.message}`, 'error');
        }
      }
    },
  });

  // Append research tool usage instructions to the system prompt
  pi.on('before_agent_start', async (event: any, _ctx: any) => {
    const researchPrompt = loadPrompt('research-tool-usage')
      .replace('{MAX_TEAM_SIZE_L1}', MAX_TEAM_SIZE_LEVEL_1.toString())
      .replace('{MAX_TEAM_SIZE_L2}', MAX_TEAM_SIZE_LEVEL_2.toString())
      .replace('{MAX_TEAM_SIZE_L3}', MAX_TEAM_SIZE_LEVEL_3.toString());
    
    // Check if this is a researcher session by examining the system prompt.
    // Note: model IDs (e.g., claude-opus-4-7) do not contain 'researcher', so we rely on
    // the system prompt containing the word 'researcher' to identify researcher sessions.
    const isResearcher = event.systemPrompt?.toLowerCase().includes('researcher');

    if (isResearcher) {
      return { systemPrompt: event.systemPrompt };
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
