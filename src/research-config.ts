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
  Box, 
  type SettingItem 
} from '@earendil-works/pi-tui';
import { setInteractiveTuiActive, initGlobalTuiController } from './tui/tui-controller.ts';
import { createComponentProxy } from './tui/tui-utils.ts';
import { getConfig, saveConfig, resetConfig } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import type { IKnowledgeStoreService } from './core/service-interfaces.ts';
import type { Theme } from './types/research-panel-types.ts';
import { SUPPORTED_MODELS, clearKnowledgeStore } from './knowledge/index.ts';
import { metrics } from './utils/metrics.ts';
import { logger } from './logger.ts';

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
  if (!(ctx as any).hasUI) {
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

  const config = { ...getConfig() };
  const depthLabels: Record<number, string> = { 1: 'normal', 2: 'deep', 3: 'ultra' };

  const initialItems: SettingItem[] = [
    // --- Core Research Settings ---
    {
      id: 'DEFAULT_RESEARCH_DEPTH',
      label: 'Research depth',
      description: 'Default depth for new research tasks (normal, deep, ultra)',
      currentValue: depthLabels[config.DEFAULT_RESEARCH_DEPTH] || String(config.DEFAULT_RESEARCH_DEPTH),
      values: ['normal', 'deep', 'ultra'],
    },
    {
      id: 'MAX_CONCURRENT_RESEARCHERS',
      label: 'Max concurrent',
      description: 'Maximum researchers allowed to run simultaneously (1-5)',
      currentValue: String(config.MAX_CONCURRENT_RESEARCHERS),
      values: ['1', '2', '3', '4', '5'],
    },
    {
      id: 'MAX_SCRAPE_BATCHES',
      label: 'Scrape batches',
      description: 'Max scrape batches per researcher (0 for unlimited)',
      currentValue: config.MAX_SCRAPE_BATCHES === 0 ? 'unlimited' : String(config.MAX_SCRAPE_BATCHES),
      values: ['unlimited', '1', '2', '3', '5', '10', '15'],
    },
    {
      id: 'WORKER_THREADS',
      label: 'Worker threads',
      description: 'Number of parallel browser workers for search and scraping',
      currentValue: String(config.WORKER_THREADS),
      values: ['1', '2', '4', '8', '12', '16'],
    },
    {
      id: 'RESEARCHER_TIMEOUT_MS',
      label: 'Timeout (min)',
      description: 'Per-researcher timeout in minutes (3-30 min)',
      currentValue: String(Math.round(config.RESEARCHER_TIMEOUT_MS / 60000)),
      values: ['3', '5', '10', '15', '20', '30'],
    },

    // --- Knowledge Store ---
    {
      id: 'KNOWLEDGE_STORE_ENABLED',
      label: 'Knowledge store',
      description: 'Enable or disable persistent research memory (RAG)',
      currentValue: config.KNOWLEDGE_STORE_ENABLED ? 'true' : 'false',
      values: ['true', 'false'],
    },
    {
      id: 'EMBEDDING_MODEL',
      label: 'Embed model',
      description: 'Model used for knowledge store embeddings (Changing clears local DB)',
      currentValue: config.EMBEDDING_MODEL,
      values: SUPPORTED_MODELS.map(m => m.id),
    },
    {
      id: 'EMBEDDING_DEVICE',
      label: 'Embed device',
      description: 'Hardware device for embeddings (webgpu is significantly faster)',
      currentValue: config.EMBEDDING_DEVICE,
      values: ['webgpu', 'cpu'],
    },
    {
      id: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
      label: 'Cache TTL (days)',
      description: 'How long to keep cached research findings (1-365 days)',
      currentValue: String(config.KNOWLEDGE_STORE_CACHE_TTL_DAYS),
      values: ['7', '14', '30', '60', '90', '180', '365'],
    },

    // --- Actions & Diagnostics ---
    {
      id: 'ACTION_HEALTH',
      label: 'System health',
      description: 'run comprehensive health checks and display results',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_KNOWLEDGE_STATUS',
      label: 'Knowledge status',
      description: 'run a report of current knowledge store statistics',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_KNOWLEDGE_CLEAR',
      label: 'Clear memory',
      description: '⚠️ run a permanent deletion of all knowledge store data',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_METRICS_VIEW',
      label: 'View metrics',
      description: 'run a report of session-wide performance metrics',
      currentValue: 'run',
      values: ['run'],
    },
    {
      id: 'ACTION_METRICS_CLEAR',
      label: 'Reset metrics',
      description: 'run a reset of all performance counters and statistics',
      currentValue: 'run',
      values: ['run'],
    },
  ];

  setInteractiveTuiActive(true);
  try {
    await ctx.ui.custom(
      (tui: TUI, theme: Theme, _kb: any, done: (val: any) => void) => {
        const listTheme = {
          label: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : text,
          value: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : theme.fg('muted', text),
          description: (text: string) => theme.fg('dim', text),
          cursor: theme.fg('accent', '→ '),
          hint: (text: string) => theme.fg('dim', text),
        };

        const settingsList = new SettingsList(
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
            } else if (id === 'KNOWLEDGE_STORE_ENABLED') {
              config.KNOWLEDGE_STORE_ENABLED = newValue === 'true';
            } else if (id === 'EMBEDDING_MODEL') {
              config.EMBEDDING_MODEL = newValue;
            } else if (id === 'EMBEDDING_DEVICE') {
              config.EMBEDDING_DEVICE = newValue;
            } else if (id === 'KNOWLEDGE_STORE_CACHE_TTL_DAYS') {
              config.KNOWLEDGE_STORE_CACHE_TTL_DAYS = parseInt(newValue, 10);
            } else {
              changed = false;
            }

            if (changed) {
              try {
                saveConfig(config);
                resetConfig();
              } catch (e: any) {
                ctx.ui.notify(`Failed to save: ${e.message}`, 'error');
              }
            }

            // 2. Handle Actions
            if (id === 'ACTION_HEALTH') {
              done({ type: 'action', action: 'health' });
            } else if (id === 'ACTION_KNOWLEDGE_STATUS') {
              done({ type: 'action', action: 'knowledge_status' });
            } else if (id === 'ACTION_KNOWLEDGE_CLEAR') {
              done({ type: 'action', action: 'knowledge_clear' });
            } else if (id === 'ACTION_METRICS_VIEW') {
              done({ type: 'action', action: 'metrics_view' });
            } else if (id === 'ACTION_METRICS_CLEAR') {
              done({ type: 'action', action: 'metrics_clear' });
            }

            tui.requestRender();
          },
          () => done({ type: 'cancel' }),
          { enableSearch: true }
        );

        // Box(0, 0) ensures we have full terminal width for borders
        const box = new Box(0, 0);
        
        const innerComponent = {
          render: (width: number) => {
            const border = theme.fg('muted', '─'.repeat(width));
            return [
              border,
              ...settingsList.render(width),
              border,
            ];
          },
          handleInput: (data: string) => {
            settingsList.handleInput(data);
            tui.requestRender();
          },
          invalidate: () => settingsList.invalidate(),
        };

        box.addChild(innerComponent);

        return createComponentProxy(box, {
          render: (width: number) => box.render(width),
          handleInput: (data: string) => innerComponent.handleInput(data),
        });
      }
    )
.then(async (result: any) => {
      // Handle actions after the TUI closes to avoid UI conflicts
      if (result?.type === 'action') {
        switch (result.action) {
          case 'health':
            await runHealthCheckAction(ctx, pi);
            break;
          case 'knowledge_status':
            await showKnowledgeStatusAction(ctx, pi);
            break;
          case 'knowledge_clear': {
            const confirmed = await ctx.ui.confirm('Clear Store', 'Are you sure you want to delete all knowledge store data?');
            if (confirmed) {
              await clearKnowledgeStore();
              ctx.ui.notify('Knowledge store cleared', 'info');
            }
            break;
          }
          case 'metrics_view':
            await showMetricsAction(ctx, pi);
            break;
          case 'metrics_clear':
            metrics.clear();
            ctx.ui.notify('System metrics reset', 'info');
            break;
        }
      }
    });
  } catch (error: any) {
    logger.error(`[Config] Menu error: ${error.message}`);
  } finally {
    setInteractiveTuiActive(false);
  }
}

// ============================================================================
// Action Handlers (Internal)
// ============================================================================

async function runHealthCheckAction(ctx: any, pi: ExtensionAPI): Promise<void> {
  ctx.ui.notify('Running health checks...', 'info');
  try {
    const systemHealth = await healthRegistry.runAll();
    const outputLines: string[] = [];
    outputLines.push('## System Health Status');
    outputLines.push('');

    const statusIcon = systemHealth.status === 'healthy' ? '✅' :
                      systemHealth.status === 'degraded' ? '⚠️' : '❌';
    outputLines.push(`**${statusIcon} Status: ${systemHealth.status.toUpperCase()}**`);
    outputLines.push('');

    for (const component of systemHealth.components) {
      const icon = component.healthy ? '✅' : '❌';
      outputLines.push(`${icon} **${component.component}**`);
      if (component.error) outputLines.push(`  - Error: ${component.error}`);
      outputLines.push(`  - Duration: ${component.durationMs.toFixed(0)}ms`);
      outputLines.push('');
    }

    pi.sendMessage({
      customType: 'health-result',
      content: outputLines.join('\n'),
      display: true,
      details: { health: systemHealth },
    });
    ctx.ui.notify(`Health check complete: ${systemHealth.status}`, 'info');
  } catch (error: any) {
    ctx.ui.notify(`Health check failed: ${error.message}`, 'error');
  }
}

async function showKnowledgeStatusAction(ctx: any, pi: ExtensionAPI): Promise<void> {
  try {
    const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
    const store = await service.getStore();
    const count = await store.count();
    
    pi.sendMessage({
      customType: 'knowledge-status',
      content: `## Knowledge Store\n\n- **Status:** Operational\n- **Entries:** ${count}\n- **Model:** ${getConfig().EMBEDDING_MODEL}\n- **Device:** ${getConfig().EMBEDDING_DEVICE}`,
      display: true,
    });
  } catch (error: any) {
    ctx.ui.notify(`Failed to get knowledge status: ${error.message}`, 'error');
  }
}

async function showMetricsAction(_ctx: any, pi: ExtensionAPI): Promise<void> {
  const snapshot = metrics.getSnapshot();
  const outputLines: string[] = ['## System Metrics', ''];
  
  if (Object.keys(snapshot.counters).length === 0 && Object.keys(snapshot.gauges).length === 0 && Object.keys(snapshot.histograms).length === 0) {
    outputLines.push('_No metrics recorded in the current session._');
  } else {
    if (Object.keys(snapshot.counters).length > 0) {
      outputLines.push('### 🔢 Counters');
      for (const [key, value] of Object.entries(snapshot.counters)) outputLines.push(`- **${key}:** ${value}`);
      outputLines.push('');
    }
    if (Object.keys(snapshot.histograms).length > 0) {
      outputLines.push('### 📊 Histograms');
      for (const [key, stats] of Object.entries(snapshot.histograms)) {
        outputLines.push(`- **${key}:** Count: ${stats.count}, Avg: ${stats.avg.toFixed(2)}ms, P99: ${stats.p99.toFixed(2)}ms`);
      }
    }
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: outputLines.join('\n'),
    display: true,
    details: { metrics: snapshot },
  });
}
