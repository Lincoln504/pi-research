/**
 * Research Configuration Command
 *
 * Consolidated interactive TUI menu for managing pi-research.
 * Provides a unified hub for:
 * - Default Research Depth
 * - System Health Monitoring
 * - Knowledge Store Management
 * - Core System Settings
 * - Run-Scoped Metrics
 *
 * Usage:
 * - /research-config  - Opens interactive TUI menu
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey, SelectList, SettingsList, Box, type SelectItem, type SettingItem } from '@earendil-works/pi-tui';
import { getConfig, saveConfig, resetConfig, getEnvFilePath } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService } from './core/service-registry.ts';
import { ServiceNames } from './core/service-interfaces.ts';
import type { IKnowledgeStoreService } from './core/service-interfaces.ts';
import { SUPPORTED_MODELS, clearKnowledgeStore } from './knowledge/index.ts';
import { metrics } from './utils/metrics.ts';
import * as os from 'node:os';

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Main command handler for /research-config
 */
export async function handleResearchConfigCommand(
  _args: string,
  ctx: any,
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
async function showInteractiveMenu(ctx: any, pi: ExtensionAPI): Promise<void> {
  const result = await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (val: any) => void) => {
      const selectTheme = {
        selectedPrefix: (text: string) => theme.fg('accent', '► ' + text),
        selectedText: (text: string) => theme.fg('accent', text),
        description: (text: string) => theme.fg('muted', text),
        scrollInfo: (text: string) => theme.fg('muted', text),
        noMatch: (text: string) => theme.fg('error', text),
      };

      const currentDepth = getConfig().DEFAULT_RESEARCH_DEPTH;
      const depthLabels: Record<number, string> = { 0: 'Quick', 1: 'Normal', 2: 'Deep', 3: 'Ultra' };

      const sections: Record<string, { title: string, items: SelectItem[] }> = {
        main: {
          title: 'Research Configuration',
          items: [
            { value: 'depth', label: 'Default Research Depth', description: `Current: ${depthLabels[currentDepth] || currentDepth} (${currentDepth})` },
            { value: 'health', label: 'Health Management', description: 'System health checks and monitoring' },
            { value: 'knowledge', label: 'Knowledge Store', description: 'Manage persistent memory' },
            { value: 'settings', label: 'System Settings', description: 'View and modify configuration' },
            { value: 'metrics', label: 'Metrics & Monitoring', description: 'View system metrics' },
          ]
        },
        depth: {
          title: 'Default Research Depth',
          items: [
            { value: '0', label: '0: Quick', description: 'Single pass, fast research' },
            { value: '1', label: '1: Normal', description: 'Coordinated, thorough research' },
            { value: '2', label: '2: Deep', description: 'Multi-round, exhaustive research' },
            { value: '3', label: '3: Ultra', description: 'Maximum depth, extreme rigor' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        health: {
          title: 'Health Management',
          items: [
            { value: 'run', label: 'Run Health Check', description: 'Execute all health checks' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        knowledge: {
          title: 'Knowledge Store',
          items: [
            { value: 'status', label: 'View Status', description: 'Show knowledge store status' },
            { value: 'clear', label: 'Clear Store', description: 'Delete all knowledge store data' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        settings: {
          title: 'System Settings',
          items: [
            { value: 'edit', label: 'Open Settings Editor', description: 'Interactive configuration editor' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        metrics: {
          title: 'Metrics & Monitoring',
          items: [
            { value: 'view', label: 'View Metrics', description: 'Show system metrics' },
            { value: 'clear', label: 'Clear Metrics', description: 'Reset all session statistics' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        }
      };

      let currentSection = 'main';
      let selectList = new SelectList(sections['main']!.items, 10, selectTheme);

      const box = new Box(2, 1);
      box.addChild({
        render: (width) => {
          const section = sections[currentSection]!;
          const lines = [
            theme.fg('accent', ` ${section.title}`),
            theme.fg('muted', ' ──────────────────────────────'),
            ...selectList.render(width - 4),
            theme.fg('muted', ' ──────────────────────────────'),
            theme.fg('muted', ' [Enter] Select   [Esc] Back/Exit'),
          ];
          return lines;
        },
        handleInput: async (data) => {
          if (matchesKey(data, 'escape')) {
            if (currentSection === 'main') {
              done({ type: 'cancel' });
            } else {
              currentSection = 'main';
              selectList = new SelectList(sections['main']!.items, 10, selectTheme);
              tui.requestRender();
            }
            return;
          }

          if (data === '\r' || data === '\n') {
            const selected = selectList.getSelectedItem();
            if (!selected) return;

            if (currentSection === 'main') {
              currentSection = selected.value;
              selectList = new SelectList(sections[currentSection]!.items, 10, selectTheme);
              tui.requestRender();
            } else {
              if (selected.value === 'back') {
                currentSection = 'main';
                selectList = new SelectList(sections['main']!.items, 10, selectTheme);
                tui.requestRender();
              } else {
                done({ type: 'action', section: currentSection, action: selected.value });
              }
            }
            return;
          }

          selectList.handleInput(data);
        },
        invalidate: () => selectList.invalidate(),
      });

      return box;
    }
  );

  if (result?.type === 'action') {
    const { section, action } = result;
    switch (section) {
      case 'depth': {
        const depth = parseInt(action, 10);
        const config = getConfig();
        config.DEFAULT_RESEARCH_DEPTH = depth;
        saveConfig(config);
        resetConfig();
        ctx.ui.notify(`Default research depth set to ${action}`, 'info');
        break;
      }
      case 'health':
        if (action === 'run') await runHealthCheckAction(ctx, pi);
        break;
      case 'knowledge':
        if (action === 'status') await showKnowledgeStatusAction(ctx, pi);
        else if (action === 'clear') {
            const confirmed = await ctx.ui.confirm('Are you sure you want to clear the entire Knowledge Store? This cannot be undone.');
            if (confirmed) {
                await clearKnowledgeStore();
                ctx.ui.notify('Knowledge Store cleared', 'info');
            }
        }
        break;
      case 'settings':
        if (action === 'edit') await showSettingsEditorAction(ctx, pi);
        break;
      case 'metrics':
        if (action === 'view') await showMetricsAction(ctx, pi);
        else if (action === 'clear') {
            metrics.clear();
            ctx.ui.notify('Metrics cleared', 'info');
        }
        break;
    }
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

async function showSettingsEditorAction(ctx: any, _pi: ExtensionAPI): Promise<void> {
  const config = { ...getConfig() }; // Work on a copy
  const envDisplayPath = getEnvFilePath().replace(os.homedir(), '~');

  const initialItems: SettingItem[] = [
    {
      id: 'MAX_CONCURRENT_RESEARCHERS',
      label: 'Max Concurrent',
      description: 'Maximum researchers allowed to run simultaneously (1-5)',
      currentValue: String(config.MAX_CONCURRENT_RESEARCHERS),
      values: ['1', '2', '3', '4', '5'],
    },
    {
      id: 'MAX_SCRAPE_BATCHES',
      label: 'Scrape Batches',
      description: 'Max scrape batches per researcher (0 for unlimited)',
      currentValue: config.MAX_SCRAPE_BATCHES === 0 ? 'Unlimited' : String(config.MAX_SCRAPE_BATCHES),
      values: ['Unlimited', '1', '2', '3', '5', '10', '15'],
    },
    {
      id: 'WORKER_THREADS',
      label: 'Worker Threads',
      description: 'Number of parallel browser workers for search and scraping',
      currentValue: String(config.WORKER_THREADS),
      values: ['1', '2', '4', '8', '12', '16'],
    },
    {
      id: 'KNOWLEDGE_STORE_ENABLED',
      label: 'Knowledge Store',
      description: 'Enable or disable persistent research memory',
      currentValue: config.KNOWLEDGE_STORE_ENABLED ? 'ON' : 'OFF',
      values: ['ON', 'OFF'],
    },
    {
      id: 'EMBEDDING_MODEL',
      label: 'Embed Model',
      description: 'Model used for knowledge store embeddings (⚠ Changing clears DB)',
      currentValue: config.EMBEDDING_MODEL,
      values: SUPPORTED_MODELS.map(m => m.id),
    },
    {
      id: 'EMBEDDING_DEVICE',
      label: 'Embed Device',
      description: 'Hardware device for embeddings (webgpu is 3-9x faster)',
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
    {
      id: 'RESEARCHER_TIMEOUT_MS',
      label: 'Timeout (min)',
      description: 'Per-researcher timeout in minutes (3-30 min)',
      currentValue: String(Math.round(config.RESEARCHER_TIMEOUT_MS / 60000)),
      values: ['3', '5', '10', '15', '20', '30'],
    },
  ];

  const result = await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (val: any) => void) => {
      const listTheme = {
        label: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : theme.fg('text', text),
        value: (text: string, selected: boolean) => selected ? theme.fg('accent', `[ ${text} ]`) : theme.fg('muted', `  ${text}  `),
        description: (text: string) => theme.fg('muted', ` ${text}`),
        cursor: theme.fg('accent', '► '),
        hint: (text: string) => theme.fg('muted', ` ${text}`),
      };

      const settingsList = new SettingsList(
        initialItems,
        10,
        listTheme,
        (id, newValue) => {
          if (id === 'KNOWLEDGE_STORE_ENABLED') config.KNOWLEDGE_STORE_ENABLED = newValue === 'ON';
          else if (id === 'MAX_CONCURRENT_RESEARCHERS' || id === 'WORKER_THREADS' || id === 'KNOWLEDGE_STORE_CACHE_TTL_DAYS') (config as any)[id] = parseInt(newValue, 10);
          else if (id === 'MAX_SCRAPE_BATCHES') config.MAX_SCRAPE_BATCHES = newValue === 'Unlimited' ? 0 : parseInt(newValue, 10);
          else if (id === 'RESEARCHER_TIMEOUT_MS') config.RESEARCHER_TIMEOUT_MS = parseInt(newValue, 10) * 60000;
          else (config as any)[id] = newValue;
          tui.requestRender();
        },
        () => done({ type: 'cancel' })
      );

      const box = new Box(2, 1);
      box.addChild({
        render: (width) => {
          return [
            theme.fg('accent', ' pi-research Configuration'),
            theme.fg('muted', ' ──────────────────────────────'),
            ...settingsList.render(width - 4),
            theme.fg('muted', ' ──────────────────────────────'),
            theme.fg('muted', ` Config: ${envDisplayPath}`),
            theme.fg('muted', ' [s] Save & Exit        [Esc] Cancel'),
          ];
        },
        handleInput: (data) => {
          if (data === 's' || data === 'S') done({ type: 'submit', data: config });
          else settingsList.handleInput(data);
        },
        invalidate: () => settingsList.invalidate(),
      });

      return box;
    }
  );

  if (result && result.type === 'submit' && result.data) {
    try {
      saveConfig(result.data);
      resetConfig();
      ctx.ui.notify('Configuration updated and saved', 'info');
    } catch (e: any) {
      ctx.ui.notify(`Invalid config: ${e.message}`, 'error');
    }
  }
}
