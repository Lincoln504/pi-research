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
} from '@earendil-works/pi-tui';
import { setInteractiveTuiActive, initGlobalTuiController } from './tui/tui-controller.ts';
import { getConfig, saveConfig, resetConfig, getDbDir } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService, clearService } from './core/service-registry.ts';
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
  initGlobalTuiController(ctx.ui);

  const initialConfig = { ...getConfig() };
  const config = { ...getConfig() };
  const depthLabels: Record<number, string> = { 1: 'normal', 2: 'deep', 3: 'ultra' };

  const scrapePct = Math.round(config.MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING * 100);

  const anyKnowledgeStore = config.LOCAL_KNOWLEDGE_STORE_ENABLED || config.GLOBAL_KNOWLEDGE_STORE_ENABLED;

  const initialItems: SettingItem[] = [
    // --- Research ---
    {
      id: 'DEFAULT_RESEARCH_DEPTH',
      label: '/research depth',
      description: 'Default depth for the /research command (normal/deep/ultra)',
      currentValue: depthLabels[config.DEFAULT_RESEARCH_DEPTH] || String(config.DEFAULT_RESEARCH_DEPTH),
      values: ['normal', 'deep', 'ultra'],
    },
    {
      id: 'MAX_CONCURRENT_RESEARCHERS',
      label: 'Max concurrent',
      description: 'Maximum researchers to run simultaneously (1-5)',
      currentValue: String(config.MAX_CONCURRENT_RESEARCHERS),
      values: ['1', '2', '3', '4', '5'],
    },
    {
      id: 'RESEARCH_REPORT_EXPORT_ENABLED',
      label: 'Export report',
      description: 'Automatically save a markdown report to disk when research completes.\nFiles go to a "research" or "docs" folder in your project, or your temp folder if at home.',
      currentValue: config.RESEARCH_REPORT_EXPORT_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    {
      id: 'MAX_SCRAPE_BATCHES',
      label: 'Scrape batches',
      description: `Max scrape batches per researcher (0=unlimited).\nAlways capped at ${scrapePct}% of the context window.`,
      currentValue: config.MAX_SCRAPE_BATCHES === 0 ? 'unlimited' : String(config.MAX_SCRAPE_BATCHES),
      values: ['unlimited', '1', '2', '3', '5', '10', '15'],
    },
    {
      id: 'WORKER_THREADS',
      label: 'Worker threads',
      description: 'Number of parallel browser workers for search and scraping (1-10)',
      currentValue: String(config.WORKER_THREADS),
      values: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    },
    {
      id: 'RESEARCHER_TIMEOUT_MS',
      label: 'Timeout (min)',
      description: 'Per-researcher timeout in minutes (3-30)',
      currentValue: String(Math.round(config.RESEARCHER_TIMEOUT_MS / 60000)),
      values: ['3', '5', '10', '15', '20', '30'],
    },
    {
      id: 'DEBUG',
      label: 'Debug logging',
      description: 'Enable verbose debug logging to the log file.\nIncludes INFO and DEBUG level output for diagnosing issues.',
      currentValue: config.DEBUG ? 'true' : 'false',
      values: ['true', 'false'],
    },

    // --- Knowledge Store ---
    {
      id: 'LOCAL_KNOWLEDGE_STORE_ENABLED',
      label: 'Project Knowledge Store',
      description: 'Store research findings scoped to this project directory. When enabled, the knowledge search tool and researcher store injection become available.',
      currentValue: config.LOCAL_KNOWLEDGE_STORE_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    {
      id: 'GLOBAL_KNOWLEDGE_STORE_ENABLED',
      label: 'User Knowledge Store',
      description: 'Store research findings shared across all project directories. When enabled, the knowledge search tool becomes available for cross-project lookups.',
      currentValue: config.GLOBAL_KNOWLEDGE_STORE_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    ...(anyKnowledgeStore ? [
      {
        id: 'EMBEDDING_MODEL',
        label: 'Embed model',
        description: 'Embedding model for the knowledge store.\nChanging model clears all stored data.',
        currentValue: config.EMBEDDING_MODEL.split('/').pop()!,
        values: SUPPORTED_MODELS.map(m => m.id.split('/').pop()!),
      },
      {
        id: 'EMBEDDING_DEVICE',
        label: 'Embed device',
        description: 'Hardware backend (webgpu is significantly faster)',
        currentValue: config.EMBEDDING_DEVICE,
        values: ['webgpu', 'cpu'],
      },
      {
        id: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
        label: 'Cache TTL (days)',
        description: 'Retention period for research findings (1-365 days)',
        currentValue: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
        values: ['7', '14', '30', '60', '90', '180', '365'],
      },
    ] as SettingItem[] : []),

    // --- Actions ---
    {
      id: 'ACTION_HEALTH',
      label: 'Check system health',
      description: 'Run comprehensive diagnostics and display results',
      currentValue: 'run',
      values: ['run'],
    },
    ...(anyKnowledgeStore ? [
      {
        id: 'ACTION_KNOWLEDGE_STATUS',
        label: 'Show knowledge status',
        description: 'Display detailed knowledge store statistics (entries, model, device)',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    ...(config.LOCAL_KNOWLEDGE_STORE_ENABLED ? [
      {
        id: 'ACTION_KNOWLEDGE_CLEAR_LOCAL',
        label: 'Clear project data',
        description: 'Permanently delete all project-scoped entries from this directory',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    ...(config.GLOBAL_KNOWLEDGE_STORE_ENABLED ? [
      {
        id: 'ACTION_KNOWLEDGE_CLEAR_GLOBAL',
        label: 'Clear user data',
        description: 'Permanently delete all shared (cross-project) entries',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    {
      id: 'ACTION_METRICS_VIEW',
      label: 'View session metrics',
      description: 'Display session performance and latency report',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_METRICS_CLEAR',
      label: 'Reset session metrics',
      description: 'Zero out all performance counters',
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
            // SettingsList calls this once per word-wrapped line (already has "  " prefix).
            // Check for the warning keyword to highlight destructive-action lines.
            if (text.includes('delete') || text.includes('clear')) {
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
            if (id === 'DEFAULT_RESEARCH_DEPTH') {
              const depthMap: Record<string, number> = { 'normal': 1, 'deep': 2, 'ultra': 3 };
              config.DEFAULT_RESEARCH_DEPTH = depthMap[newValue] || 1;
            } else if (id === 'MAX_CONCURRENT_RESEARCHERS') {
              config.MAX_CONCURRENT_RESEARCHERS = parseInt(newValue, 10);
            } else if (id === 'MAX_SCRAPE_BATCHES') {
              config.MAX_SCRAPE_BATCHES = newValue === 'unlimited' ? 0 : parseInt(newValue, 10);
            } else if (id === 'WORKER_THREADS') {
              config.WORKER_THREADS = parseInt(newValue, 10);
            } else if (id === 'RESEARCHER_TIMEOUT_MS') {
              config.RESEARCHER_TIMEOUT_MS = parseInt(newValue, 10) * 60000;
            } else if (id === 'DEBUG') {
              config.DEBUG = newValue === 'true';
            } else if (id === 'RESEARCH_REPORT_EXPORT_ENABLED') {
              config.RESEARCH_REPORT_EXPORT_ENABLED = newValue === 'true';
            } else if (id === 'LOCAL_KNOWLEDGE_STORE_ENABLED') {
              config.LOCAL_KNOWLEDGE_STORE_ENABLED = newValue === 'true';
            } else if (id === 'GLOBAL_KNOWLEDGE_STORE_ENABLED') {
              config.GLOBAL_KNOWLEDGE_STORE_ENABLED = newValue === 'true';
            } else if (id === 'EMBEDDING_MODEL') {
              config.EMBEDDING_MODEL = SUPPORTED_MODELS.find(m => m.id.split('/').pop() === newValue)?.id ?? newValue;
            } else if (id === 'EMBEDDING_DEVICE') {
              config.EMBEDDING_DEVICE = newValue as 'webgpu' | 'cpu';
            } else if (id === 'KNOWLEDGE_STORE_CACHE_TTL_DAYS') {
              config.KNOWLEDGE_STORE_CACHE_TTL_DAYS = parseInt(newValue, 10);
            } else {
              changed = false;
            }

            if (changed) {
              try {
                saveConfig(config);
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
            }

          },
          () => wrappedDone({ type: 'cancel' }),
          { enableSearch: true }
        );

        // No polling timer needed — stats removed from menu

        return {
          render: (width: number) => {
            const border = theme.fg('muted', '─'.repeat(width));
            const listLines = settingsList.render(width);
            return [border, ...listLines, border];
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
          const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
          await service.clear();
          await clearService(ServiceNames.KNOWLEDGE_STORE);
          clearEmbeddingInstance();
          ctx.ui.notify('Model changed: Knowledge store cleared', 'info');
        } catch (e: unknown) {
          logger.warn('[research-config] Failed to clear knowledge store on model change:', e);
        }
      } else if (config.EMBEDDING_DEVICE !== initialConfig.EMBEDDING_DEVICE) {
        logger.info('[research-config] Device changed. Resetting service.');
        try {
          await clearService(ServiceNames.KNOWLEDGE_STORE);
          clearEmbeddingInstance();
          ctx.ui.notify('Device changed: Service refreshed', 'info');
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
            const confirmed = await ctx.ui.confirm('Clear User Data', 'Are you sure you want to delete all user (cross-project) knowledge store data?');
            if (confirmed) {
              try {
                const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
                await service.clearGlobal();
                ctx.ui.notify('User knowledge data cleared', 'info');
              } catch (e: unknown) {
                ctx.ui.notify(`Failed to clear user store: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }
            break;
          }
          case 'knowledge_clear_local': {
            const confirmed = await ctx.ui.confirm('Clear Project Data', 'Are you sure you want to delete project-specific data from the store?');
            if (confirmed) {
              try {
                const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
                await service.clearLocal();
                ctx.ui.notify('Project-specific data cleared', 'info');
              } catch (e: unknown) {
                ctx.ui.notify(`Failed to clear local project data: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }
            break;
          }
          case 'metrics_view':
            await showMetricsAction(ctx, pi);
            break;
          case 'metrics_clear':
            metrics.clearSession();
            ctx.ui.notify('Session metrics reset', 'info');
            break;
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
    ctx.ui.notify('Running health checks...', 'info');
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
      ctx.ui.notify(`Health check complete: ${systemHealth.status}`, 'info');
    }
  } catch (error: unknown) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Health check failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

async function showKnowledgeStatusAction(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  try {
    // Reset config to ensure we read the latest from file (in case TUI changed it)
    resetConfig();
    const config = getConfig();
    
    const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
    const store = await service.getStore();
    const counts = await store.countScoped();
    const dbDir = getDbDir();
    
    pi.sendMessage({
      customType: 'knowledge-status',
      content: `## Knowledge Store\n\n- **Status:** Operational\n- **Project Entries:** ${counts.local}\n- **User Entries:** ${counts.global}, across ${counts.projects} Projects\n- **Model:** ${config.EMBEDDING_MODEL}\n- **Device:** ${config.EMBEDDING_DEVICE}\n- **Unified Path:** \`${dbDir}\``,
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
