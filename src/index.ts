import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import { createResearchTool } from './tool.ts';
import { logger } from './logger.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { initKnowledgeStore, shutdownKnowledgeStore } from './knowledge/index.ts';

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

  // Initialize knowledge store (non-blocking)
  initKnowledgeStore().catch(err => {
    logger.error('[pi-research] Knowledge store initialization failed:', err);
  });

  // Ensure background resources like browser pools and knowledge store are cleaned up
  const handleShutdown = (signal: string) => {
    logger.log(`[pi-research] Received ${signal}, initiating cleanup...`);
    shutdownManager.runCleanup(signal).catch(err => {
      logger.error(`[pi-research] ${signal} cleanup failed:`, err);
    });
  };

  shutdownManager.register(async () => {
    await shutdownKnowledgeStore();
  });

  process.once('SIGINT', () => handleShutdown('SIGINT'));
  process.once('SIGTERM', () => handleShutdown('SIGTERM'));
  process.once('SIGHUP', () => handleShutdown('SIGHUP'));

  // Global extension state for smart dual-sided prompt injection
  let currentTurn = 0;
  let lastInjectionTurn = -10;
  // Reduced cooldown for safety constraints (NO SUBAGENTS should be reinforced frequently)
  const COOLDOWN_TURNS = 3;
  // Match research keywords including common typos (reserach, reseach, resarch, etc)
  const RESEARCH_REGEX = /\b(research|reserach|reseach|resarch|search|web|analyze|investigate)\b/i;

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

      // Define configuration items with their types and handlers
      type ConfigKey = keyof typeof config;
      
      interface BaseConfigItem {
        key?: ConfigKey;
        label: string;
        description: string;
      }

      interface NumberConfigItem extends BaseConfigItem {
        type: 'number';
        key: ConfigKey;
        min: number;
        max: number;
        step: number;
        displayMin: number;
        displayMax: number;
        toDisplay: (value: number) => number;
        fromDisplay: (display: number) => number;
        format: (value: number) => string;
      }

      interface BooleanConfigItem extends BaseConfigItem {
        type: 'boolean';
        key: ConfigKey;
      }

      interface StringConfigItem extends BaseConfigItem {
        type: 'string';
        key: ConfigKey;
        options?: string[]; // For selectors
        warning?: string;
      }

      interface ActionConfigItem extends BaseConfigItem {
        type: 'action';
        action: () => Promise<void>;
      }

      type ConfigItem = NumberConfigItem | BooleanConfigItem | StringConfigItem | ActionConfigItem;

      const configItems: ConfigItem[] = [
        {
          type: 'number',
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
          type: 'number',
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
          type: 'boolean',
          key: 'KNOWLEDGE_STORE_ENABLED',
          label: 'Knowledge Store',
          description: '(Persistent memory)',
        },
        {
          type: 'string',
          key: 'EMBEDDING_MODEL',
          label: 'Embedding Model',
          description: '(Local vector space)',
          warning: '(Warning: Changing models permanently clears the database)',
        },
        {
          type: 'number',
          key: 'CHUNK_SIZE_CHARS',
          label: 'Chunk Size',
          description: '(Characters)',
          min: 500,
          max: 10000,
          displayMin: 500,
          displayMax: 10000,
          step: 100,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          type: 'number',
          key: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
          label: 'Cache TTL',
          description: '(Days)',
          min: 1,
          max: 365,
          displayMin: 1,
          displayMax: 365,
          step: 1,
          toDisplay: (v) => v,
          fromDisplay: (v) => v,
          format: (v) => `${v}d`,
        },
        {
          type: 'number',
          key: 'RESEARCHER_TIMEOUT_MS',
          label: 'Researcher Timeout',
          description: '(3-30 min)',
          min: 180000,
          max: 1800000,
          displayMin: 180,
          displayMax: 1800,
          step: 30,
          toDisplay: (v) => v / 1000,
          fromDisplay: (v) => v * 1000,
          format: (v) => `${v}s`,
        },
        {
          type: 'action',
          label: 'Clear DB Cache',
          description: '(Delete all knowledge)',
          action: async () => {
            const { getEnvFilePath } = await import('./config.ts');
            const path = await import('node:path');
            const fs = await import('node:fs');
            const dbDir = path.join(path.dirname(getEnvFilePath()), 'knowledge_db');
            if (fs.existsSync(dbDir)) {
              fs.rmSync(dbDir, { recursive: true, force: true });
            }
          },
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
            private statusMsg = '';

            constructor() {
              this.selectedIndex = 0;
            }

            render(width: number): string[] {
              // Check cache
              if (this.cachedWidth === width && this.cachedVersion === this.version) {
                return this.cachedLines;
              }

              const sep = theme.fg('accent', '─'.repeat(Math.max(0, width - 2)));
              const lines = [theme.fg('accent', ' pi-research Configuration'), sep];

              configItems.forEach((item, idx) => {
                const isSelected = idx === this.selectedIndex;
                const prefix = isSelected ? theme.fg('accent', '► ') : '  ';
                
                let valueDisplay = '';
                let desc = item.description;

                if (item.type === 'number') {
                  const value = config[item.key] as number;
                  valueDisplay = item.format(item.toDisplay(value)).padStart(10);
                } else if (item.type === 'boolean') {
                  const value = config[item.key] as boolean;
                  valueDisplay = (value ? '[ON]' : '[OFF]').padStart(10);
                } else if (item.type === 'string') {
                  const value = config[item.key] as string;
                  valueDisplay = (value.length > 10 ? '...' + value.slice(-7) : value).padStart(10);
                  if (isSelected && item.warning) desc = theme.fg('warning', item.warning);
                } else if (item.type === 'action') {
                  valueDisplay = '[EXECUTE]'.padStart(10);
                }

                const line = `${prefix}${item.label.padEnd(20)} ${isSelected ? theme.fg('accent', valueDisplay) : valueDisplay} ${desc}`;
                lines.push(theme.fg('text', line));
              });

              lines.push(sep);
              if (this.statusMsg) {
                lines.push(theme.fg('success', ` ${this.statusMsg}`));
              }
              lines.push(theme.fg('muted', ' ↑↓ Navigate  ←→ Adjust/Toggle  [Enter] Save/Exec  [Esc] Cancel'));

              // Truncate lines to fit within width
              this.cachedLines = lines.map(line => {
                const lw = visibleWidth(line);
                return lw > width ? truncateToWidth(line, Math.max(1, width)) : line;
              });
              this.cachedWidth = width;
              this.cachedVersion = this.version;

              return this.cachedLines;
            }

            async handleInput(key: string): Promise<void> {
              // Escape - cancel
              if (matchesKey(key, 'escape')) {
                done({ type: 'cancel' });
                return;
              }

              // Enter - save or execute action
              if (key === '\r' || key === '\n') {
                const item = configItems[this.selectedIndex];
                if (item.type === 'action') {
                  this.statusMsg = 'Executing...';
                  this.version++;
                  tui.requestRender();
                  await item.action();
                  this.statusMsg = 'Action completed';
                  this.version++;
                  tui.requestRender();
                  setTimeout(() => { this.statusMsg = ''; this.version++; tui.requestRender(); }, 2000);
                  return;
                }
                done({ type: 'submit', data: config });
                return;
              }

              // Up/Down arrows
              if (matchesKey(key, 'up')) {
                this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : configItems.length - 1;
                this.version++;
                tui.requestRender();
                return;
              }
              if (matchesKey(key, 'down')) {
                this.selectedIndex = this.selectedIndex < configItems.length - 1 ? this.selectedIndex + 1 : 0;
                this.version++;
                tui.requestRender();
                return;
              }

              // Left/Right arrows
              if (matchesKey(key, 'left') || matchesKey(key, 'right')) {
                const item = configItems[this.selectedIndex];
                if (!item) return;

                if (item.type === 'number') {
                  const currentValue = config[item.key] as number;
                  const currentDisplay = item.toDisplay(currentValue);
                  const isRight = matchesKey(key, 'right');
                  const newDisplay = isRight 
                    ? Math.min(item.displayMax, currentDisplay + item.step)
                    : Math.max(item.displayMin, currentDisplay - item.step);
                  const newValue = item.fromDisplay(newDisplay);
                  if (newValue !== currentValue) {
                    (config[item.key] as any) = newValue;
                    this.version++;
                    tui.requestRender();
                  }
                } else if (item.type === 'boolean') {
                  (config[item.key] as any) = !config[item.key];
                  this.version++;
                  tui.requestRender();
                } else if (item.type === 'string') {
                  // For now, strings are just informational or toggled if options exist
                  if (item.options) {
                    const currentIdx = item.options.indexOf(config[item.key] as string);
                    const isRight = matchesKey(key, 'right');
                    const nextIdx = isRight 
                      ? (currentIdx + 1) % item.options.length
                      : (currentIdx - 1 + item.options.length) % item.options.length;
                    (config[item.key] as any) = item.options[nextIdx];
                    this.version++;
                    tui.requestRender();
                  }
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

  // Dual-Sided JIT Prompt Injection (User Input + LLM Output) with Cooldown
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    currentTurn++;
    
    // Do not inject rules into the sub-researchers
    const isResearcher = event.systemPrompt?.toLowerCase().includes('researcher');
    if (isResearcher) {
      return { systemPrompt: event.systemPrompt };
    }

    // 1. Scan User Input
    let needsResearch = RESEARCH_REGEX.test(event.prompt || '');

    // 2. Scan LLM Output (if user didn't explicitly ask)
    if (!needsResearch) {
      const branch = ctx?.sessionManager?.getBranch?.() || [];
      // Grab the last assistant message
      const lastAssistant = [...branch].reverse().find((e: any) => e.type === 'message' && e.message.role === 'assistant');
      if (lastAssistant) {
        needsResearch = RESEARCH_REGEX.test(JSON.stringify(lastAssistant.message.content));
      }
    }

    // 3. Inject ONLY if matched AND cooldown has passed
    if (needsResearch && (currentTurn - lastInjectionTurn >= COOLDOWN_TURNS)) {
      lastInjectionTurn = currentTurn;
      logger.debug('[pi-research] JIT constraint rule injected (Dual-Scan matched).');
      
      const researchPrompt = loadPrompt('research-tool-usage')
        .replace('{MAX_TEAM_SIZE_L1}', MAX_TEAM_SIZE_LEVEL_1.toString())
        .replace('{MAX_TEAM_SIZE_L2}', MAX_TEAM_SIZE_LEVEL_2.toString())
        .replace('{MAX_TEAM_SIZE_L3}', MAX_TEAM_SIZE_LEVEL_3.toString());
      
      return {
        systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
      };
    }

    return { systemPrompt: event.systemPrompt };
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
