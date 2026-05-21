import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import { visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import { createResearchTool } from './tool.ts';
import { logger } from './logger.ts';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { shutdownKnowledgeStore, isKnowledgeStoreReady, getStore, SUPPORTED_MODELS } from './knowledge/index.ts';
import { loadPrompt } from './utils/prompts.ts';
import { clearAllSessionState } from './utils/session-state.ts';
import { stopBrowserManager } from './infrastructure/browser-manager.ts';

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

  // Global uncaught exception handler to catch synchronous errors that escape all promise handlers.
  // This is a last-resort guard for things like undici's EventEmitter-based socket close errors.
  let uncaughtExceptionCount = 0;
  const MAX_UNCAUGHT_EXCEPTIONS = 3;

  shutdownManager.registerEventListener(process, 'uncaughtException', (err: Error, origin: string) => {
    // EPIPE = pi closed its stdout/stderr pipe before we finished writing (normal at shutdown).
    // Check before incrementing so it never contributes to the crash threshold.
    if (err.message.includes('EPIPE') || (err as any).code === 'EPIPE') {
      logger.warn('[pi-research] EPIPE — pipe closed (normal at shutdown), ignoring.');
      return;
    }

    uncaughtExceptionCount++;
    const errorMsg = `[pi-research] Uncaught exception #${uncaughtExceptionCount}/${MAX_UNCAUGHT_EXCEPTIONS}: ${err.message}`;
    const errorOrigin = `[origin: ${origin}]`;

    logger.error(`${errorMsg} ${errorOrigin}`, err);

    // Log stack trace for debugging
    if (err.stack) {
      logger.error(`[pi-research] Stack trace:\n${err.stack}`);
    }

    // If we've hit too many uncaught exceptions, let the process exit to prevent infinite loops
    if (uncaughtExceptionCount >= MAX_UNCAUGHT_EXCEPTIONS) {
      logger.error('[pi-research] Too many uncaught exceptions. Exiting process to prevent infinite loop.');
      process.exit(1);
    }

    // For common recoverable errors (like undici socket timeouts), don't crash the process.
    // These can happen during network operations and are handled at a higher level via retries.
    const isNetworkError =
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('terminated') ||
      err.message.includes('socket');

    if (isNetworkError) {
      logger.warn('[pi-research] Network error caught by uncaught exception handler. Continuing...');
      return; // Don't crash on network errors
    }

    // For unknown error types, log a warning but continue
    logger.warn('[pi-research] Continuing after uncaught exception. Application state may be corrupted.');
  });

  // Also handle unhandled promise rejections
  shutdownManager.registerEventListener(process, 'unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('[pi-research] Unhandled promise rejection:', error.message, error);
    
    // Log stack trace if available
    if (error.stack) {
      logger.error(`[pi-research] Rejection stack trace:\n${error.stack}`);
    }
  });

  // Ensure background resources like browser pools and knowledge store are cleaned up
  const handleShutdown = (signal: string) => {
    logger.log(`[pi-research] Received ${signal}, initiating cleanup...`);
    shutdownManager.runCleanup(signal).then(() => {
      logger.log(`[pi-research] Cleanup complete, exiting...`);
      // Clean exit after successful cleanup
      process.exit(0);
    }).catch(err => {
      logger.error(`[pi-research] ${signal} cleanup failed:`, err);
      // Force exit after 10 seconds if cleanup hangs (browser pool can take up to 10s)
      shutdownManager.forceExitAfter(10000, 1);
    });
  };

  // Register cleanup tasks in the order they should run in reverse:
  // 1. stopBrowserManager (runs last - slow, up to 10s for pool destruction)
  // 2. shutdownKnowledgeStore (runs second - disposes embedder to prevent DefaultLogger crash)
  // 3. clearAllSessionState (runs first - fast)
  shutdownManager.register(async () => {
    await stopBrowserManager();
  });

  shutdownManager.register(async () => {
    await shutdownKnowledgeStore();
  });

  // Clear all session state on shutdown to ensure timeouts are cleared
  shutdownManager.register(() => {
    clearAllSessionState();
  });

  // Primary cleanup path for pi -p (print mode) and normal session end.
  // Pi fires session_shutdown from disposeRuntime() before process.exit() so this
  // reliably drains the writer queue and disposes the embedder even in non-signal exits.
  pi.on('session_shutdown', async () => {
    try {
      await shutdownManager.runCleanup('session_shutdown');
    } catch (err) {
      logger.error('[pi-research] session_shutdown cleanup failed:', err);
    }
    // Force exit after 5 seconds if cleanup hangs (shouldn't happen normally)
    shutdownManager.forceExitAfter(5000);
  });

  // Signal handlers as a secondary path (interactive mode, external kill, SIGHUP).
  // Use shutdownManager.registerEventListener for proper cleanup
  const handleSIGINT = () => handleShutdown('SIGINT');
  const handleSIGTERM = () => handleShutdown('SIGTERM');
  const handleSIGHUP = () => handleShutdown('SIGHUP');

  process.once('SIGINT', handleSIGINT);
  process.once('SIGTERM', handleSIGTERM);
  process.once('SIGHUP', handleSIGHUP);

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

      const { getConfig, validateConfig, saveConfig, resetConfig, getEnvFilePath, getDbDir } = await import('./config.ts');
      const config = { ...getConfig() }; // Work on a copy


      // pi-research model cache directory — matches the env.cacheDir set in embedder.ts
      const xdgCacheBase = process.env['XDG_CACHE_HOME'];
      const piModelCache = pathmod.join(
        xdgCacheBase ?? pathmod.join(os.homedir(), '.cache'),
        'pi-research', 'models'
      );

      function isModelCached(modelId: string): boolean {
        const onnxDir = pathmod.join(piModelCache, ...modelId.split('/'), 'onnx');
        try {
          return fss.readdirSync(onnxDir).some(f => f.endsWith('.onnx'));
        } catch {
          return false;
        }
      }

      // Config file path for display (home dir replaced with ~)
      const envDisplayPath = getEnvFilePath().replace(os.homedir(), '~');

      // Fetch knowledge store entry count (non-blocking, best-effort)
      let storeCountLabel = '';
      if (config.KNOWLEDGE_STORE_ENABLED) {
        const dbDir = getDbDir();
        if (isKnowledgeStoreReady()) {
          try {
            const st = await getStore();
            const n = await st.count();
            storeCountLabel = ` (${n} entries)`;
          } catch { /* non-fatal */ }
        } else if (fss.existsSync(dbDir)) {
          try {
            const lancedb = await import('@lancedb/lancedb');
            const db = await lancedb.connect(dbDir);
            const tableNames = await db.tableNames();
            if (tableNames.includes('knowledge')) {
              const table = await db.openTable('knowledge');
              const n = await table.countRows();
              storeCountLabel = ` (${n} entries)`;
            } else {
              storeCountLabel = ' (0 entries)';
            }
          } catch { storeCountLabel = ' (? entries)'; }
        } else {
          storeCountLabel = ' (0 entries)';
        }
      }

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
          min: 1, max: 5, displayMin: 1, displayMax: 5, step: 1,
          toDisplay: (v) => v, fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          type: 'number',
          key: 'DEFAULT_RESEARCH_DEPTH',
          label: 'Default Depth',
          description: '(0=quick 1-3=deep)',
          min: 0, max: 3, displayMin: 0, displayMax: 3, step: 1,
          toDisplay: (v) => v, fromDisplay: (v) => v,
          format: (v) => v.toString(),
        },
        {
          type: 'number',
          key: 'MAX_SCRAPE_BATCHES',
          label: 'Scrape Batches',
          description: '(0=unlimited)',
          min: 0, max: 99, displayMin: 0, displayMax: 99, step: 1,
          toDisplay: (v) => v, fromDisplay: (v) => v,
          format: (v) => v === 0 ? 'Unlimited' : v.toString(),
        },
        {
          type: 'number',
          key: 'WORKER_THREADS',
          label: 'Worker Threads',
          description: '(Browser pool)',
          min: 1, max: 16, displayMin: 1, displayMax: 16, step: 1,
          toDisplay: (v) => v, fromDisplay: (v) => v,
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
          label: 'Embed Model',
          description: '(←→ cycle models)',
          options: SUPPORTED_MODELS.map(m => m.id),
          warning: '⚠ Changing model clears DB',
        },
        {
          type: 'string',
          key: 'EMBEDDING_DEVICE',
          label: 'Embed Device',
          description: '(←→ webgpu/cpu)',
          options: ['webgpu', 'cpu'],
        },
        {
          type: 'number',
          key: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
          label: 'Cache TTL',
          description: '(Days)',
          min: 1, max: 365, displayMin: 1, displayMax: 365, step: 1,
          toDisplay: (v) => v, fromDisplay: (v) => v,
          format: (v) => `${v}d`,
        },
        {
          type: 'number',
          key: 'RESEARCHER_TIMEOUT_MS',
          label: 'Researcher Timeout',
          description: '(3-30 min)',
          min: 180000, max: 1800000, displayMin: 180, displayMax: 1800, step: 30,
          toDisplay: (v) => v / 1000,
          fromDisplay: (v) => v * 1000,
          format: (v) => `${v}s`,
        },
        {
          type: 'action',
          label: 'Clear DB Cache',
          get description() { return `(Delete all knowledge${storeCountLabel})`; },
          action: async () => {
            const dbDir = getDbDir();
            if (fss.existsSync(dbDir)) {
              fss.rmSync(dbDir, { recursive: true, force: true });
            }
            storeCountLabel = ' (0 entries)';
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
            private readonly originalModel: string;

            constructor() {
              this.selectedIndex = 0;
              this.originalModel = config['EMBEDDING_MODEL'] as string;
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
                  if (item.key === 'EMBEDDING_MODEL' && item.options && item.options.length > 0) {
                    const modelInfo = SUPPORTED_MODELS.find(m => m.id === value);
                    const cached = isModelCached(value);
                    const langLabel = modelInfo?.multilingual ? '[multi]' : '[EN]';

                    // Value column: lang capability when ready, download notice when not.
                    // [local]/[fetch] removed — lang tag is more informative at a glance.
                    valueDisplay = (cached ? langLabel : '[auto-dl]').padStart(10);

                    // Description: model ID truncated to fit.
                    // When not cached, append lang tag here since value col is taken by [auto-dl].
                    // Available visible chars = width − fixed prefix (2+20+1+10+1 = 34)
                    const available = Math.max(20, width - 34);
                    const suffix = !cached ? ` ${langLabel}` : '';
                    const nameMax = Math.max(5, available - suffix.length);
                    const displayName = value.length <= nameMax
                      ? value
                      : value.slice(0, nameMax - 3) + '...';

                    if (isSelected) {
                      const langColor = modelInfo?.multilingual ? 'accent' : 'muted';
                      desc = displayName + (!cached ? ' ' + theme.fg(langColor, langLabel) : '');
                    } else {
                      desc = displayName + suffix;
                    }
                  } else if (item.options && item.options.length > 0) {
                    // Generic option selector (e.g. Embed Device): show the selected value directly.
                    valueDisplay = value.padStart(10);
                    if (isSelected && item.warning) desc = theme.fg('warning', item.warning);
                  } else {
                    valueDisplay = (value.length > 10 ? '...' + value.slice(-7) : value).padStart(10);
                    if (isSelected && item.warning) desc = theme.fg('warning', item.warning);
                  }
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
              lines.push(theme.fg('muted', ` Config: ${envDisplayPath}`));
              const selKey = configItems[this.selectedIndex]?.key;
              if (selKey === 'EMBEDDING_MODEL') {
                const currentModel = config['EMBEDDING_MODEL'] as string;
                const modelReady = isModelCached(currentModel);
                const statusText = modelReady ? 'downloaded' : 'not downloaded — auto-downloads on first use';
                lines.push(theme.fg(modelReady ? 'muted' : 'warning', ` Model: ${statusText}`));
                lines.push(theme.fg('muted', ` Dir:   ${piModelCache}`));
              }
              if ((config['EMBEDDING_MODEL'] as string) !== this.originalModel) {
                lines.push(theme.fg('warning', ` ⚠ Changing model permanently clears the knowledge DB`));
              }

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
                if (item && item.type === 'action' && 'action' in item) {
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
