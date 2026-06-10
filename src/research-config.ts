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
  truncateToWidth,
} from '@earendil-works/pi-tui';
import * as fs from 'node:fs';
import { setInteractiveTuiActive, initGlobalTuiController } from './tui/tui-controller.ts';
// safeUnref removed — no polling timer in config menu anymore
import { getConfig, saveConfig, resetConfig, getDbDir, getGlobalEnvFilePath, getLocalEnvFilePath } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService, clearService } from './core/service-registry.ts';
import { ServiceNames, IKnowledgeStoreService } from './core/service-interfaces.ts';
import { KnowledgeStoreService } from './infrastructure/knowledge-store-service.ts';
import { clearEmbeddingInstance } from './infrastructure/embedding/embedding-factory.ts';
import type { Theme } from './types/research-panel-types.ts';
import { SUPPORTED_MODELS } from './knowledge/index.ts';
import { metrics } from './utils/metrics.ts';
import { logger } from './logger.ts';

// ============================================================================
// Utilities
// ============================================================================

function formatTimeAgo(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

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

  const initialItems: SettingItem[] = [
    // --- Core Research Settings ---
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
      label: 'Project scope',
      description: 'Enable project-specific knowledge for this directory.',
      currentValue: config.LOCAL_KNOWLEDGE_STORE_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    {
      id: 'GLOBAL_KNOWLEDGE_STORE_ENABLED',
      label: 'Shared scope',
      description: 'Enable shared knowledge (cross-project, different directories).',
      currentValue: config.GLOBAL_KNOWLEDGE_STORE_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },

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

    // --- Actions & Diagnostics ---
    {
      id: 'ACTION_HEALTH',
      label: 'Check system health',
      description: 'Run comprehensive diagnostics and display results',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_KNOWLEDGE_STATUS',
      label: 'Show knowledge status',
      description: 'Display detailed knowledge store statistics',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_KNOWLEDGE_CLEAR_LOCAL',
      label: 'Clear project data',
      description: 'Permanently delete all project-scoped entries',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_KNOWLEDGE_CLEAR_GLOBAL',
      label: 'Clear shared data',
      description: 'Permanently delete all shared entries',
      currentValue: 'run',
      values: ['run'],
    },
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
            const globalEnvPath = getGlobalEnvFilePath();
            const localEnvPath = getLocalEnvFilePath();
            const hasLocal = fs.existsSync(localEnvPath);
            const activeEnvPath = hasLocal ? localEnvPath : globalEnvPath;
            const footerLines = [
              '',
              theme.fg('dim', truncateToWidth(`  Config: ${activeEnvPath}`, width)),
              theme.fg('dim', truncateToWidth(`  "Project" refers to this distinct directory on your system.`, width)),
              theme.fg('dim', truncateToWidth(`  See file for all settings (PI_RESEARCH_MODEL, timeouts, paths, and more).`, width)),
            ];
            return [border, ...settingsList.render(width), border, ...footerLines, border];
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
            const confirmed = await ctx.ui.confirm('Clear Shared Data', 'Are you sure you want to delete all global shared knowledge store data?');
            if (confirmed) {
              try {
                const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
                await service.clearGlobal();
                ctx.ui.notify('Global shared data cleared', 'info');
              } catch (e: unknown) {
                ctx.ui.notify(`Failed to clear global store: ${e instanceof Error ? e.message : String(e)}`, 'error');
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
      content: `## Knowledge Store\n\n- **Status:** Operational\n- **Project Entries:** ${counts.local}\n- **Shared Entries:** ${counts.global}, across ${counts.projects} Projects\n- **Model:** ${config.EMBEDDING_MODEL}\n- **Device:** ${config.EMBEDDING_DEVICE}\n- **Unified Path:** \`${dbDir}\``,
      display: true,
    });
  } catch (error: unknown) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Failed to get knowledge status: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

async function showMetricsAction(_ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const sessionSnapshot = metrics.getSessionSnapshot();
  const runHistory     = metrics.getRunHistory();
  const sessionStart   = metrics.getSessionStartedAt();

  const lines: string[] = ['## Pi Session Metrics', ''];
  lines.push('Scope: current Pi session (resets when Pi exits or metrics are cleared manually)');
  lines.push(`Session started: ${formatTimeAgo(new Date(sessionStart).toISOString())}`);
  lines.push(`Runs this session: ${runHistory.length}`);
  lines.push('');

  // ── Session-level infrastructure data ──────────────────────────────────
  const hasSessionCounters   = Object.keys(sessionSnapshot.counters).length > 0;
  const hasSessionHistograms = Object.keys(sessionSnapshot.histograms).length > 0;

  if (hasSessionCounters || hasSessionHistograms) {
    lines.push('### Session Infrastructure (startup, locks, coordination)');
    if (hasSessionCounters) {
      for (const [key, value] of Object.entries(sessionSnapshot.counters)) {
        lines.push(`- **${key}:** ${value}`);
      }
    }
    if (hasSessionHistograms) {
      for (const [key, stats] of Object.entries(sessionSnapshot.histograms)) {
        lines.push(`- **${key}:** Count: ${stats.count}, Avg: ${stats.avg.toFixed(2)}ms, P99: ${stats.p99.toFixed(2)}ms`);
      }
    }
    lines.push('');
  }

  // ── Per-run history ─────────────────────────────────────────────────────
  if (runHistory.length === 0) {
    lines.push('_No research runs in this session._');
  } else {
    const lastRun = runHistory[runHistory.length - 1]!;
    const runIdShort = lastRun.runId.slice(0, 8);
    const statusLabel = lastRun.status === 'success' ? '[OK]'
                      : lastRun.status === 'cancelled' ? '[--]'
                      : '[ERR]';

    lines.push(`### Last Run \`${runIdShort}\``);
    lines.push(`**Status:** ${statusLabel} ${lastRun.status} | **Duration:** ${(lastRun.durationMs / 1000).toFixed(1)}s | **Completed:** ${formatTimeAgo(new Date(lastRun.completedAt).toISOString())}`);
    lines.push('');

    const { counters, gauges, histograms } = lastRun.snapshot;

    if (Object.keys(counters).length > 0) {
      lines.push('#### Counters');
      for (const [key, value] of Object.entries(counters)) {
        lines.push(`- **${key}:** ${value}`);
      }
      lines.push('');
    }

    if (Object.keys(gauges).length > 0) {
      lines.push('#### Gauges');
      for (const [key, value] of Object.entries(gauges)) {
        lines.push(`- **${key}:** ${value}`);
      }
      lines.push('');
    }

    if (Object.keys(histograms).length > 0) {
      lines.push('#### Latency & Performance');
      for (const [key, stats] of Object.entries(histograms)) {
        lines.push(`- **${key}:** Count: ${stats.count}, Avg: ${stats.avg.toFixed(2)}ms, P99: ${stats.p99.toFixed(2)}ms`);
      }
      lines.push('');
    }

    // ── Prior run compact summary ─────────────────────────────────────────
    if (runHistory.length > 1) {
      const prior = runHistory.slice(0, -1).slice().reverse();
      lines.push(`### Prior Runs (${prior.length})`);
      for (const run of prior) {
        const icon = run.status === 'success' ? '[OK]'
                   : run.status === 'cancelled' ? '[--]'
                   : '[ERR]';
        lines.push(`- ${icon} \`${run.runId.slice(0, 8)}\` ${(run.durationMs / 1000).toFixed(1)}s — ${formatTimeAgo(new Date(run.completedAt).toISOString())}`);
      }
      lines.push('');
    }
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: lines.join('\n'),
    display: true,
    details: {
      metrics: {
        session: sessionSnapshot,
        runs: runHistory,
        sessionStartedAt: sessionStart,
      },
    },
  });
}
