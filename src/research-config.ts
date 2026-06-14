/**
 * Research Configuration Command
 *
 * Consolidated interactive TUI menu for managing pi-research.
 * Mirrored after the official Pi settings experience:
 * - Single flat scrollable list
 * - Active item centered with description
 * - Enter/Space to cycle values
 * - Automatic saving on change
 * - Search support
 *
 * Usage:
 * - /research-config  - Opens interactive TUI menu
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import {
  SettingsList,
  type SettingItem,
  visibleWidth,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import { setInteractiveTuiActive, initGlobalTuiController } from './tui/tui-controller.ts';
import { getConfig, saveConfig, resetConfig, getDbDir } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService, clearService, tryGetServiceContainerFromCtx } from './core/service-registry.ts';
import { ServiceNames, IKnowledgeStoreService } from './core/service-interfaces.ts';
import { KnowledgeStoreService } from './infrastructure/knowledge-store-service.ts';
import { clearEmbeddingInstance } from './infrastructure/embedding/embedding-factory.ts';
import type { Theme } from './types/research-panel-types.ts';
import { SUPPORTED_MODELS } from './knowledge/index.ts';
import { metrics } from './utils/metrics.ts';
import {
  extractRunStats,
  aggregateSessionStats,
  buildSessionOverview,
  buildRunCompactLine,
} from './utils/metrics-summary.ts';
import { logger } from './logger.ts';
import { formatTimeAgo, formatDuration } from './utils/text-utils.ts';
import * as path from 'node:path';

// ============================================================================
// Utilities
// ============================================================================

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Main command handler for /research-config
 */
export async function handleResearchConfigCommand(
  _args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('Interactive menu requires UI mode', 'error');
    return;
  }
  await showInteractiveMenu(ctx, pi);
}

// ============================================================================
// Interactive TUI Menu
// ============================================================================

/**
 * Show interactive TUI menu for research configuration
 */
async function showInteractiveMenu(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  // Ensure the global TUI controller is initialized
  const piSessionId = (ctx as any).sessionId || (ctx as any).sessionManager?.getSessionId();
  initGlobalTuiController(ctx.ui, piSessionId);

  const cwd = ctx.cwd || process.cwd();
  const initialConfig = { ...getConfig(cwd) };
  const config = { ...getConfig(cwd) };
  const container = tryGetServiceContainerFromCtx(ctx);
  const depthLabels: Record<number, string> = { 1: 'normal', 2: 'deep', 3: 'ultra' };

  const anyKnowledgeStore = config.KNOWLEDGE_STORE_MODE !== 'none';

  const initialItems: SettingItem[] = [
    // ── Project-scoped settings (saved per-directory) ──
    {
      id: 'DEFAULT_RESEARCH_DEPTH',
      label: 'Research Depth',
      description: 'Default depth for the /research command (normal, deep, ultra).\n[project] means configured independently per directory.',
      currentValue: depthLabels[config.DEFAULT_RESEARCH_DEPTH] || String(config.DEFAULT_RESEARCH_DEPTH),
      values: ['normal', 'deep', 'ultra'],
    },
    {
      id: 'KNOWLEDGE_STORE_MODE',
      label: 'Knowledge Mode',
      description: 'Knowledge store isolation — none (disabled), project (entries confined to this directory), or global (shared across all projects).\n[project] means configured independently per directory.',
      currentValue: config.KNOWLEDGE_STORE_MODE,
      values: ['none', 'project', 'global'],
    },
    {
      id: 'RESEARCHER_TIMEOUT_MS',
      label: 'Researcher Timeout',
      description: 'Minutes before a stalled research track is forcefully cancelled.',
      currentValue: String(Math.round(config.RESEARCHER_TIMEOUT_MS / 60000)),
      values: ['3', '5', '10', '15', '20', '30'],
    },
    {
      id: 'MAX_CONCURRENT_RESEARCHERS',
      label: 'Max Concurrency',
      description: 'Parallel researcher threads. Reduce this if you hit API rate-limit errors.',
      currentValue: String(config.MAX_CONCURRENT_RESEARCHERS),
      values: ['1', '2', '3', '4', '5'],
    },
    {
      id: 'MAX_SCRAPE_BATCHES',
      label: 'Scrape Batches',
      description: 'Max URL batches a researcher can fetch (0 = unlimited). Lower values conserve API credit.',
      currentValue: config.MAX_SCRAPE_BATCHES === 0 ? 'unlimited' : String(config.MAX_SCRAPE_BATCHES),
      values: ['unlimited', '1', '2', '3', '5', '10', '15'],
    },
    {
      id: 'RESEARCH_REPORT_EXPORT_ENABLED',
      label: 'Auto-export Report',
      description: 'Write a markdown report to disk when each research run completes.',
      currentValue: config.RESEARCH_REPORT_EXPORT_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    {
      id: 'WORKER_THREADS',
      label: 'Browser Workers',
      description: 'Parallel browser processes for search and scraping. Higher values use more CPU and RAM.',
      currentValue: String(config.WORKER_THREADS),
      values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    },
    ...(anyKnowledgeStore ? [
      {
        id: 'EMBEDDING_MODEL',
        label: 'Embedding Model',
        description: 'Vector model for semantic search. Changing this renames current data to a backup and starts fresh.',
        currentValue: config.EMBEDDING_MODEL.split('/').pop()!,
        values: SUPPORTED_MODELS.map(m => m.id.split('/').pop()!),
      },
      {
        id: 'EMBEDDING_DEVICE',
        label: 'Embedding Device',
        description: 'Hardware backend for the embedding model. CPU is safer for headless or server environments.',
        currentValue: config.EMBEDDING_DEVICE,
        values: ['webgpu', 'cpu'],
      },
      {
        id: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
        label: 'Cache Retention',
        description: 'Days to retain findings before automated eviction. Longer = more disk, shorter = fresher data.',
        currentValue: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
        values: ['7', '14', '30', '60', '90', '180', '365'],
      },
    ] as SettingItem[] : []),
    {
      id: 'DEBUG',
      label: 'Debug Logging',
      description: 'Write verbose diagnostics to /tmp/pi-research.log for troubleshooting.',
      currentValue: config.DEBUG ? 'true' : 'false',
      values: ['true', 'false'],
    },

    // ── Actions ──
    {
      id: 'ACTION_HEALTH',
      label: 'Run Diagnostics',
      description: 'Test browser pool, GPU, and database connectivity.',
      currentValue: 'run',
      values: ['run'],
    },
    ...(anyKnowledgeStore ? [
      {
        id: 'ACTION_KNOWLEDGE_STATUS',
        label: 'Database Status',
        description: 'Show entry counts, disk usage, and the active embedding model.',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    ...(config.KNOWLEDGE_STORE_MODE === 'project' ? [
      {
        id: 'ACTION_KNOWLEDGE_CLEAR_LOCAL',
        label: 'Clear Project Store',
        description: 'Permanently delete all entries tied to this project directory.',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    ...(config.KNOWLEDGE_STORE_MODE === 'global' ? [
      {
        id: 'ACTION_KNOWLEDGE_CLEAR_GLOBAL',
        label: 'Clear User Store',
        description: 'Permanently delete all globally shared store entries.',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    {
      id: 'ACTION_METRICS_VIEW',
      label: 'View Session Metrics',
      description: 'Show token usage, API cost estimates, and success rates for the current session.',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_METRICS_CLEAR',
      label: 'Reset Session Metrics',
      description: 'Clear all performance counters for the current session.',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_LOGS_CLEAR',
      label: 'Clear Debug Logs',
      description: 'Delete the diagnostic log file and all archived rotation files.',
      currentValue: 'run',
      values: ['run'],
    },
  ];

  setInteractiveTuiActive(true);
  try {
    await ctx.ui.custom(
      (_tui: TUI, theme: Theme, _kb: any, done: (val: any) => void) => {
        const listTheme = {
          label: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : text,
          value: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : theme.fg('muted', text),
          description: (text: string) => {
            // Apply warning color to the line if the *original* description contained destructive keywords.
            // Since wrapTextWithAnsi returns an array of strings, this function is called for each line.
            // The previous logic was failing because it checked the individual line, not the full context.
            // We need a way to know if the *original* description had the keyword.
            
            // Re-evaluating: SettingsList calls this for each wrapped line.
            // If the original description had 'delete' or 'clear', all lines should be yellow.
            // I need to check the selected item's description.
            const selectedItem = initialItems[settingsList['selectedIndex']]; 
            const desc = selectedItem?.description?.toLowerCase() || '';
            if (desc.includes('delete') || desc.includes('clear')) {
              return theme.fg('warning', text);
            }
            return theme.fg('dim', text);
          },
          cursor: theme.fg('accent', '→ '),
          hint: (text: string) => theme.fg('dim', text),
        };

        let settingsList: SettingsList;

        const wrappedDone = (val: any) => {
          done(val);
        };

        settingsList = new SettingsList(
          initialItems,
          10,
          listTheme,
          async (id, newValue) => {
            // 1. Handle Settings Changes (Auto-save)
            let changed = true;
            let scope: 'local' | 'user' = 'local';

            if (id === 'DEFAULT_RESEARCH_DEPTH') {
              const depthMap: Record<string, number> = { 'normal': 1, 'deep': 2, 'ultra': 3 };
              config.DEFAULT_RESEARCH_DEPTH = depthMap[newValue] || 1;
            } else if (id === 'MAX_CONCURRENT_RESEARCHERS') {
              config.MAX_CONCURRENT_RESEARCHERS = parseInt(newValue, 10);
              scope = 'user';
            } else if (id === 'MAX_SCRAPE_BATCHES') {
              config.MAX_SCRAPE_BATCHES = newValue === 'unlimited' ? 0 : parseInt(newValue, 10);
              scope = 'user';
            } else if (id === 'WORKER_THREADS') {
            config.WORKER_THREADS = parseInt(newValue, 10);
            scope = 'user';
            } else if (id === 'RESEARCHER_TIMEOUT_MS') {
            config.RESEARCHER_TIMEOUT_MS = parseInt(newValue, 10) * 60000;
            scope = 'user';
            } else if (id === 'DEBUG') {
            config.DEBUG = newValue === 'true';
            scope = 'user';
            } else if (id === 'RESEARCH_REPORT_EXPORT_ENABLED') {
            config.RESEARCH_REPORT_EXPORT_ENABLED = newValue === 'true';
            scope = 'user';
            } else if (id === 'KNOWLEDGE_STORE_MODE') {
              config.KNOWLEDGE_STORE_MODE = newValue as 'none' | 'project' | 'global';
            } else if (id === 'EMBEDDING_MODEL') {
            config.EMBEDDING_MODEL = SUPPORTED_MODELS.find(m => m.id.split('/').pop() === newValue)?.id ?? newValue;
            scope = 'user';
            } else if (id === 'EMBEDDING_DEVICE') {
            config.EMBEDDING_DEVICE = newValue as 'webgpu' | 'cpu';
            scope = 'user';
            } else if (id === 'KNOWLEDGE_STORE_CACHE_TTL_DAYS') {
            config.KNOWLEDGE_STORE_CACHE_TTL_DAYS = parseInt(newValue, 10);
            scope = 'user';
            } else {
            changed = false;
            }

            if (changed) {
              try {
                saveConfig(config, scope, cwd);
                resetConfig();
              } catch (e: unknown) {
                ctx.ui.notify(`Failed to save: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }

            // 2. Handle Actions
            if (id === 'ACTION_HEALTH') {
              wrappedDone({ type: 'action', action: 'health' });
            } else if (id === 'ACTION_KNOWLEDGE_STATUS') {
              wrappedDone({ type: 'action', action: 'knowledge_status' });
            } else if (id === 'ACTION_KNOWLEDGE_CLEAR_GLOBAL') {
              wrappedDone({ type: 'action', action: 'knowledge_clear_global' });
            } else if (id === 'ACTION_KNOWLEDGE_CLEAR_LOCAL') {
              wrappedDone({ type: 'action', action: 'knowledge_clear_local' });
            } else if (id === 'ACTION_METRICS_VIEW') {
              wrappedDone({ type: 'action', action: 'metrics_view' });
            } else if (id === 'ACTION_METRICS_CLEAR') {
              wrappedDone({ type: 'action', action: 'metrics_clear' });
            } else if (id === 'ACTION_LOGS_CLEAR') {
              wrappedDone({ type: 'action', action: 'logs_clear' });
            }

          },
          () => wrappedDone({ type: 'cancel' }),
          { enableSearch: true }
        );

        const wrapText = (text: string, width: number): string[] => {
          const words = text.split(' ');
          const lines: string[] = [];
          let currentLine = '';
          for (const word of words) {
            if ((currentLine.length + word.length + 1) > width) {
              if (currentLine) lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = currentLine ? `${currentLine} ${word}` : word;
            }
          }
          if (currentLine) lines.push(currentLine);
          return lines;
        };

        return {
          render: (width: number) => {
            if (width < 4) return [];
            const border = theme.fg('muted', '─'.repeat(width));
            const listLines = settingsList.render(width);
            
            // Header with title and search hint
            const titleText = 'Research Configuration';
            const hintText = 'Type to search';
            const header = `${titleText} ${theme.fg('dim', `(${hintText})`)}`;
            
            // Project info to appear right above description
            const pathInfoText = `Project: ${path.basename(cwd)}`;
            const wrappedPathInfo = wrapText(pathInfoText, width - 2).map(line => theme.fg('dim', ` ${line}`));
            
            const lines = [border, header, border, ...listLines, '', ...wrappedPathInfo];
            return lines.map(line => {
              if (visibleWidth(line) > width) {
                return truncateToWidth(line, width);
              }
              return line;
            });
          },
          handleInput: (data: string) => settingsList.handleInput(data),
          invalidate: () => settingsList.invalidate(),
        };
      }
    )
.then(async (result: any) => {
      // 1. Handle Critical Config Changes (Model/Device)
      // We do this after the TUI closes to avoid race conditions and redundant clears
      if (config.EMBEDDING_MODEL !== initialConfig.EMBEDDING_MODEL) {
        logger.info(`[research-config] Embedding model changed from ${initialConfig.EMBEDDING_MODEL} to ${config.EMBEDDING_MODEL}. Clearing knowledge store.`);
        try {
          const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
          await service.clear();
          await clearService(ServiceNames.KNOWLEDGE_STORE, container);
          clearEmbeddingInstance();
          ctx.ui.notify('Model updated. Store cleared.', 'info');
          } catch (e: unknown) {
          logger.warn('[research-config] Failed to clear knowledge store on model change:', e);
          }
          } else if (config.EMBEDDING_DEVICE !== initialConfig.EMBEDDING_DEVICE) {
          logger.info('[research-config] Device changed. Resetting service.');
          try {
          await clearService(ServiceNames.KNOWLEDGE_STORE, container);
          clearEmbeddingInstance();
          ctx.ui.notify('Device updated. Service refreshed.', 'info');

        } catch (e: unknown) {
          logger.warn('[research-config] Failed to refresh service on device change:', e);
        }
      }

      // 2. Handle Actions after the TUI closes to avoid UI conflicts
      if (result?.type === 'action') {
        switch (result.action) {
          case 'health':
            await runHealthCheckAction(ctx, pi);
            break;
          case 'knowledge_status':
            await showKnowledgeStatusAction(ctx, pi);
            break;
          case 'knowledge_clear_global': {
            const confirmed = await ctx.ui.confirm('Clear User Store', 'Permanently delete all user-scoped store data?');
            if (confirmed) {
              try {
                const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
                await service.clearGlobal();
                ctx.ui.notify('User store cleared.', 'info');
              } catch (e: unknown) {
                ctx.ui.notify(`Clear failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }
            break;
          }
          case 'knowledge_clear_local': {
            const confirmed = await ctx.ui.confirm('Clear Project Store', 'Permanently delete all project-scoped store data?');
            if (confirmed) {
              try {
                const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
                await service.clearLocal();
                ctx.ui.notify('Project store cleared.', 'info');
              } catch (e: unknown) {
                ctx.ui.notify(`Clear failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }
            break;
          }
          case 'metrics_view':
            await showMetricsAction(ctx, pi);
            break;
          case 'metrics_clear':
            metrics.clearSession();
            ctx.ui.notify('Metrics reset.', 'info');
            break;
          case 'logs_clear': {
            const confirmed = await ctx.ui.confirm('Clear Logs', 'Delete the main diagnostic log file and all archived rotation files?');
            if (confirmed) {
              logger.clear();
              ctx.ui.notify('Diagnostic logs cleared.', 'info');
            }
            break;
          }
        }
      }
    });
  } catch (error: unknown) {
    logger.error(`[Config] Menu error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setInteractiveTuiActive(false);
  }
}

// ============================================================================
// Action Handlers (Internal)
// ============================================================================

async function runHealthCheckAction(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (ctx.hasUI) {
    ctx.ui.notify('Running health checks.', 'info');
  }
  try {
    const systemHealth = await healthRegistry.runAll({ force: true });
    const outputLines: string[] = [];
    outputLines.push('## System Health Status');
    outputLines.push('');

    const statusIcon = systemHealth.status === 'healthy' ? '[OK]' :
                      systemHealth.status === 'degraded' ? '[WARN]' : '[ERROR]';
    outputLines.push(`**${statusIcon} Status: ${systemHealth.status.toUpperCase()}**`);
    outputLines.push('');

    for (const component of systemHealth.components) {
      const icon = component.healthy ? '[OK]' : '[FAIL]';
      outputLines.push(`${icon} **${component.component}**`);
      if (component.error) outputLines.push(`  - Error: ${component.error}`);
      outputLines.push(`  - Duration: ${component.durationMs.toFixed(1)}ms`);
      outputLines.push('');
    }

    pi.sendMessage({
      customType: 'health-result',
      content: outputLines.join('\n'),
      display: true,
      details: { health: systemHealth },
    });
    if (ctx.hasUI) {
      ctx.ui.notify(`Health check complete: ${systemHealth.status}.`, 'info');
    }
  } catch (error: unknown) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Health check failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

async function showKnowledgeStatusAction(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  try {
    const cwd = ctx.cwd || process.cwd();
    const container = tryGetServiceContainerFromCtx(ctx);
    // Reset config to ensure we read the latest from file (in case TUI changed it)
    resetConfig();
    const config = getConfig(cwd);
    
    const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
    const store = await service.getStore();
    if (!store) {
      throw new Error('Knowledge store is disabled or not initialized');
    }
    const counts = await store.countScoped(cwd);
    const dbDir = getDbDir(config, cwd);
    
    pi.sendMessage({
      customType: 'knowledge-status',
      content: `## Knowledge Store\n\n- Status: Operational\n- Project Entries: ${counts.local}\n- User Entries: ${counts.global}\n- Total Projects: ${counts.projects}\n- Model: ${config.EMBEDDING_MODEL}\n- Device: ${config.EMBEDDING_DEVICE}\n- Path: \`${dbDir}\``,
      display: true,
    });
  } catch (error: unknown) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Failed to get knowledge status: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

async function showMetricsAction(_ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const runHistory     = metrics.getRunHistory();
  const sessionStart   = metrics.getSessionStartedAt();

  const lines: string[] = ['## Session Metrics', ''];
  lines.push(`Session started ${formatTimeAgo(new Date(sessionStart).toISOString())}`);
  lines.push('');

  // ── Session Overview ──────────────────────────────────────────────────
  const sessionStats = aggregateSessionStats(runHistory);
  sessionStats.sessionStartedAt = sessionStart;

  if (runHistory.length === 0) {
    lines.push('_No research runs in this session._');
  } else {
    lines.push(buildSessionOverview(sessionStats));
    lines.push('');

    // ── Last Run Detail ──────────────────────────────────────────────────
    const lastRun = runHistory[runHistory.length - 1]!;
    const lastStats = extractRunStats(lastRun.snapshot);

    lines.push(`### Last Run`);
    const statusIcon = lastRun.status === 'success' ? '✓'
                     : lastRun.status === 'cancelled' ? '⊘'
                     : '✗';
    lines.push(`${statusIcon} \`${lastRun.runId.slice(0, 8)}\` — ${formatDuration(lastRun.durationMs)} — completed ${formatTimeAgo(new Date(lastRun.completedAt).toISOString())}`);
    lines.push('');

    if (lastStats) {
      const activityParts: string[] = [];
      if (lastStats.researchersLaunched > 0) activityParts.push(`**${lastStats.researchersLaunched}** researchers`);
      if (lastStats.roundsCompleted > 0) activityParts.push(`**${lastStats.roundsCompleted}** rounds`);
      if (activityParts.length > 0) lines.push(activityParts.join(' · '));

      const discoveryParts: string[] = [];
      if (lastStats.searchQueries > 0) discoveryParts.push(`**${lastStats.searchQueries}** searches`);
      if (lastStats.urlsDiscovered > 0) discoveryParts.push(`**${lastStats.urlsDiscovered}** discovered`);
      if (lastStats.urlsAnalyzed > 0) {
        const layerParts: string[] = [`${lastStats.urlsAnalyzed} analyzed`];
        if (lastStats.fetchSuccess > 0 && lastStats.browserSuccess > 0) {
          layerParts.push(`${lastStats.fetchSuccess} fetch`);
          layerParts.push(`${lastStats.browserSuccess} browser`);
        }
        discoveryParts.push(`**${layerParts.join(', ')}**`);
      }
      if (discoveryParts.length > 0) lines.push(discoveryParts.join(' · '));

      const toolParts: string[] = [];
      if (lastStats.toolUsage.searches > 0) toolParts.push(`${lastStats.toolUsage.searches} searches`);
      if (lastStats.toolUsage.scrapes > 0) toolParts.push(`${lastStats.toolUsage.scrapes} scrapes`);
      if (lastStats.toolUsage.securitySearches > 0) toolParts.push(`${lastStats.toolUsage.securitySearches} security`);
      if (lastStats.toolUsage.stackexchangeQueries > 0) toolParts.push(`${lastStats.toolUsage.stackexchangeQueries} StackExchange`);
      if (lastStats.toolUsage.knowledgeLookups > 0) toolParts.push(`${lastStats.toolUsage.knowledgeLookups} knowledge`);
      if (toolParts.length > 0) lines.push(`Tools: ${toolParts.join(' · ')}`);

      const resourceParts: string[] = [];
      if (lastStats.tokens > 0) resourceParts.push(`**${lastStats.tokens.toLocaleString('en-US')}** tokens`);
      if (lastStats.urlsFailed > 0) resourceParts.push(`**${lastStats.urlsFailed}** failed`);
      if (lastStats.errors > 0) resourceParts.push(`**${lastStats.errors}** errors`);
      if (resourceParts.length > 0) lines.push(resourceParts.join(' · '));

      lines.push('');
    }

    // ── Prior Runs ─────────────────────────────────────────────────────
    if (runHistory.length > 1) {
      const prior = runHistory.slice(0, -1).slice().reverse();
      lines.push(`### Prior Runs`);
      for (const run of prior) {
        lines.push(buildRunCompactLine(run as any));
      }
      lines.push('');
    }
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: lines.join('\n'),
    display: true,
  });
}
