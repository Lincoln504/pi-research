/**
 * Settings Command Module
 *
 * Handles settings management commands:
 * - View current settings
 * - Interactive settings editor
 * - Reset to defaults
 * - Clear knowledge store cache
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SettingsList, Box, type SettingItem } from '@earendil-works/pi-tui';
import { getConfig, validateConfig, saveConfig, resetConfig, getEnvFilePath } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { SUPPORTED_MODELS, clearKnowledgeStore } from '../knowledge/index.ts';
import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import * as os from 'node:os';
import type { ExtendedCommandContext } from './command-types.ts';

/**
 * Handle settings-related actions
 */
export async function handleSettingsAction(
  action: string | undefined,
  _params: string[],
  ctx: ExtendedCommandContext,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'show':
    case 'view':
    case undefined:
      await showSettingsSummary(ctx, pi);
      break;
    case 'edit':
      await showSettingsEditor(ctx, pi);
      break;
    case 'reset':
      await resetSettings(ctx);
      break;
    case 'clear-cache':
      await clearCacheAction(ctx);
      break;
    default:
      ctx.ui.notify(`Unknown settings action: ${action}. Use: show, edit, reset, clear-cache`, 'error');
  }
}

/**
 * Show a summary of current research settings
 */
export async function showSettingsSummary(ctx: ExtendedCommandContext, pi: ExtensionAPI): Promise<void> {
  const config = getConfig();
  
  // pi-research model cache directory
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

  const envDisplayPath = getEnvFilePath().replace(os.homedir(), '~');
  const dbDir = pathmod.join(process.env['XDG_DATA_HOME'] || pathmod.join(os.homedir(), '.local', 'share'), 'pi-research', 'knowledge_db');

  // Fetch knowledge store entry count
  let storeCountLabel = '';
  if (config.KNOWLEDGE_STORE_ENABLED) {
    try {
      const service = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
      if (service.isReady()) {
        const store = await service.getStore();
        const n = await store.count();
        storeCountLabel = ` (${n} entries)`;
      } else if (fss.existsSync(dbDir)) {
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
      } else {
        storeCountLabel = ' (0 entries)';
      }
    } catch {
      storeCountLabel = ' (? entries)';
    }
  }

  const outputLines = [
    '## Research Extension Settings',
    '',
    `**Environment File:** \`${envDisplayPath}\``,
    '',
    '### 🌐 Web Research',
    `- **Concurrency:** ${config.MAX_CONCURRENT_RESEARCHERS} researchers, ${config.WORKER_THREADS} browser workers`,
    `- **Search Engine:** DuckDuckGo Lite (via managed pool)`,
    `- **Timeouts:** Researcher: ${Math.round(config.RESEARCHER_TIMEOUT_MS / 1000)}s`,
    '',
    '### 🧠 Knowledge Store',
    `- **Status:** ${config.KNOWLEDGE_STORE_ENABLED ? 'Enabled' : 'Disabled'}${storeCountLabel}`,
    `- **Current Model:** \`${config.EMBEDDING_MODEL}\` (${isModelCached(config.EMBEDDING_MODEL) ? '✅ Cached' : '☁️ Online'})`,
    `- **Cache TTL:** ${config.KNOWLEDGE_STORE_CACHE_TTL_DAYS} days`,
    '',
    '### 🧪 Supported Embedding Models',
  ];

  for (const m of SUPPORTED_MODELS) {
    const cached = isModelCached(m.id);
    const current = m.id === config.EMBEDDING_MODEL;
    outputLines.push(`${current ? '**' : ''}- \`${m.id}\`${m.multilingual ? ' (multilingual)' : ''} ${cached ? '✅' : '☁️'}${current ? '**' : ''}`);
  }

  outputLines.push('', '*Legend: ✅ = model files cached locally, ☁️ = needs download on first use*');

  pi.sendMessage({
    customType: 'settings-summary',
    content: outputLines.join('\n'),
    display: true,
  });

  ctx.ui.notify('Research settings displayed', 'info');
}

/**
 * Interactive settings editor
 */
export async function showSettingsEditor(ctx: ExtendedCommandContext, _pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('Settings editor requires interactive mode', 'error');
    return;
  }

  const config = { ...getConfig() }; // Work on a copy
  const envDisplayPath = getEnvFilePath().replace(os.homedir(), '~');

  const updateItems = async (): Promise<SettingItem[]> => {
    const items: SettingItem[] = [
      {
        id: 'MAX_CONCURRENT_RESEARCHERS',
        label: 'Max Concurrent',
        description: 'Maximum researchers allowed to run simultaneously (1-5)',
        currentValue: String(config.MAX_CONCURRENT_RESEARCHERS),
        values: ['1', '2', '3', '4', '5'],
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
        id: 'RESEARCHER_TIMEOUT_MS',
        label: 'Timeout (min)',
        description: 'Per-researcher timeout in minutes (3-30 min)',
        currentValue: String(Math.round(config.RESEARCHER_TIMEOUT_MS / 60000)),
        values: ['3', '5', '10', '15', '20', '30'],
      },
    ];
    return items;
  };

  const initialItems = await updateItems();

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
          // Update config copy when a value changes
          if (id === 'KNOWLEDGE_STORE_ENABLED') {
            config.KNOWLEDGE_STORE_ENABLED = newValue === 'ON';
          } else if (id === 'MAX_CONCURRENT_RESEARCHERS' || id === 'WORKER_THREADS') {
            (config as any)[id] = parseInt(newValue, 10);
          } else if (id === 'RESEARCHER_TIMEOUT_MS') {
            config.RESEARCHER_TIMEOUT_MS = parseInt(newValue, 10) * 60000;
          } else {
            (config as any)[id] = newValue;
          }
          tui.requestRender();
        },
        () => done({ type: 'cancel' })
      );

      const box = new Box(2, 1);
      box.addChild({
        render: (width) => {
          const lines = [
            theme.fg('accent', ' pi-research Configuration'),
            theme.fg('muted', ' ──────────────────────────────'),
            ...settingsList.render(width - 4),
            theme.fg('muted', ' ──────────────────────────────'),
            theme.fg('muted', ` Config: ${envDisplayPath}`),
            theme.fg('muted', ' [Enter] Save & Exit   [Esc] Cancel'),
          ];
          return lines;
        },
        handleInput: (data) => {
          if (data === '\r' || data === '\n') {
            done({ type: 'submit', data: config });
          } else {
            settingsList.handleInput(data);
          }
        },
        invalidate: () => settingsList.invalidate(),
      });

      return box;
    }
  );

  if (result && result.type === 'submit' && result.data) {
    try {
      validateConfig(result.data);
      saveConfig(result.data);
      resetConfig();
      ctx.ui.notify('Configuration updated and saved', 'info');
    } catch (e: any) {
      ctx.ui.notify(`Invalid config: ${e.message}`, 'error');
    }
  }
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(ctx: ExtendedCommandContext): Promise<void> {
  resetConfig();
  ctx.ui.notify('Settings reset to defaults (reload required)', 'warning');
}

/**
 * Clear knowledge store action
 */
async function clearCacheAction(ctx: ExtendedCommandContext): Promise<void> {
  try {
    await clearKnowledgeStore();
    ctx.ui.notify('Knowledge store cleared', 'info');
  } catch (err) {
    ctx.ui.notify(`Failed to clear cache: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}
