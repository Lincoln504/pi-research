/**
 * Settings Command Module
 *
 * Handles settings management commands:
 * - View current settings
 * - Interactive settings editor
 * - Reset to defaults
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import { getConfig, validateConfig, saveConfig, resetConfig, getEnvFilePath } from '../config.ts';
import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import * as os from 'node:os';
import {
  isKnowledgeStoreReady,
  getStore,
  SUPPORTED_MODELS,
  clearKnowledgeStore,
} from '../knowledge/index.ts';

export interface CommandContext {
  ui: {
    notify: (message: string, type: string) => void;
    custom?: any;
  };
  hasUI?: boolean;
  cwd?: string;
}

/**
 * Handle settings-related actions
 */
export async function handleSettingsAction(
  action: string | undefined,
  _params: string[],
  ctx: CommandContext,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'view':
    case undefined:
      await showSettings(ctx, pi);
      break;
    case 'edit':
      await showSettingsEditor(ctx, pi);
      break;
    case 'reset':
      resetSettings(ctx);
      break;
    default:
      ctx.ui.notify(`Unknown settings action: ${action}. Use: view, edit, reset`, 'error');
  }
}

/**
 * Display current settings
 */
export async function showSettings(ctx: CommandContext, pi: ExtensionAPI): Promise<void> {
  const config = getConfig();
  const outputLines: string[] = [];
  
  outputLines.push('## Current Settings');
  outputLines.push('');
  outputLines.push('### Research Configuration');
  outputLines.push(`- Default Research Depth: ${config.DEFAULT_RESEARCH_DEPTH}`);
  outputLines.push(`- Max Concurrent Researchers: ${config.MAX_CONCURRENT_RESEARCHERS}`);
  outputLines.push(`- Max Scrape Batches: ${config.MAX_SCRAPE_BATCHES}`);
  outputLines.push(`- Researcher Timeout: ${(config.RESEARCHER_TIMEOUT_MS / 1000).toFixed(0)}s`);
  outputLines.push('');
  outputLines.push('### Browser Configuration');
  outputLines.push(`- Worker Threads: ${config.WORKER_THREADS}`);
  outputLines.push(`- Worker Concurrency: ${config.WORKER_CONCURRENCY}`);
  outputLines.push('');
  outputLines.push('### Knowledge Store');
  outputLines.push(`- Enabled: ${config.KNOWLEDGE_STORE_ENABLED}`);
  outputLines.push(`- Embedding Model: ${config.EMBEDDING_MODEL}`);
  outputLines.push(`- Embedding Device: ${config.EMBEDDING_DEVICE}`);
  outputLines.push(`- Cache TTL: ${config.KNOWLEDGE_STORE_CACHE_TTL_DAYS} days`);
  outputLines.push('');
  outputLines.push(`### Configuration File`);
  outputLines.push(`- Path: ${getEnvFilePath().replace(os.homedir(), '~')}`);

  pi.sendMessage({
    customType: 'settings-result',
    content: outputLines.join('\n'),
    display: true,
    details: { config },
  });

  ctx.ui.notify('Settings displayed', 'info');
}

/**
 * Interactive settings editor
 */
export async function showSettingsEditor(ctx: CommandContext, _pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('Settings editor requires interactive mode', 'error');
    return;
  }

  const config = { ...getConfig() }; // Work on a copy

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

  type ConfigKey = keyof typeof config;
  
  interface BaseConfigItem {
    key?: ConfigKey;
    label: string;
    description: string;
    hidden?: () => boolean;
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
    options?: string[];
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
      hidden: () => !config.KNOWLEDGE_STORE_ENABLED,
    },
    {
      type: 'string',
      key: 'EMBEDDING_DEVICE',
      label: 'Embed Device',
      description: '(←→ webgpu/cpu)',
      options: ['webgpu', 'cpu'],
      hidden: () => !config.KNOWLEDGE_STORE_ENABLED,
    },
    {
      type: 'number',
      key: 'KNOWLEDGE_STORE_CACHE_TTL_DAYS',
      label: 'Cache TTL',
      description: '(Days)',
      min: 1, max: 365, displayMin: 1, displayMax: 365, step: 1,
      toDisplay: (v) => v, fromDisplay: (v) => v,
      format: (v) => `${v}d`,
      hidden: () => !config.KNOWLEDGE_STORE_ENABLED,
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
        await clearKnowledgeStore();
        storeCountLabel = ' (0 entries)';
      },
      hidden: () => !config.KNOWLEDGE_STORE_ENABLED,
    },
  ];

  const result = await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (val: any) => void) => {
      class ConfigDashboardComponent {
        private selectedIndex: number = 0;
        private cachedLines: string[] = [];
        private cachedWidth = 0;
        private cachedVersion = -1;
        private version = 0;
        private statusMsg = '';
        private readonly originalModel: string;

        constructor() {
          this.originalModel = config['EMBEDDING_MODEL'] as string;
        }

        private get visibleItems() {
          return configItems.filter(item => !item.hidden?.());
        }

        private clampSelection(): void {
          const len = this.visibleItems.length;
          if (this.selectedIndex >= len) this.selectedIndex = Math.max(0, len - 1);
        }

        render(width: number): string[] {
          if (this.cachedWidth === width && this.cachedVersion === this.version) {
            return this.cachedLines;
          }

          const sep = theme.fg('accent', '─'.repeat(Math.max(0, width - 2)));
          const lines = [theme.fg('accent', ' pi-research Configuration'), sep];

          const visibleItems = this.visibleItems;
          visibleItems.forEach((item, idx) => {
            const isSelected = idx === this.selectedIndex;
            const prefix = isSelected ? theme.fg('accent', '► ') : '  ';
            
            let valueDisplay = '';
            let desc = item.description;

            if (item.type === 'number') {
              const value = config[item.key] as number;
              valueDisplay = item.format(item.toDisplay(value)).padStart(10);
            } else if (item.type === 'boolean') {
              const value = config[item.key] as boolean;
              valueDisplay = (value ? 'ON' : 'OFF').padStart(10);
            } else if (item.type === 'string') {
              const value = config[item.key] as string;
              if (item.key === 'EMBEDDING_MODEL' && item.options && item.options.length > 0) {
                const modelInfo = SUPPORTED_MODELS.find(m => m.id === value);
                const cached = isModelCached(value);
                const langLabel = modelInfo?.multilingual ? 'multi' : 'EN';
                valueDisplay = (cached ? langLabel : 'auto-dl').padStart(10);
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
          const selKey = visibleItems[this.selectedIndex]?.key;
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

          this.cachedLines = lines.map(line => {
            const lw = visibleWidth(line);
            return lw > width ? truncateToWidth(line, Math.max(1, width)) : line;
          });
          this.cachedWidth = width;
          this.cachedVersion = this.version;

          return this.cachedLines;
        }

        async handleInput(key: string): Promise<void> {
          if (matchesKey(key, 'escape')) {
            done({ type: 'cancel' });
            return;
          }

          if (key === '\r' || key === '\n') {
            const item = this.visibleItems[this.selectedIndex];
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

          if (matchesKey(key, 'up')) {
            const len = this.visibleItems.length;
            this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : len - 1;
            this.version++;
            tui.requestRender();
            return;
          }
          if (matchesKey(key, 'down')) {
            const len = this.visibleItems.length;
            this.selectedIndex = this.selectedIndex < len - 1 ? this.selectedIndex + 1 : 0;
            this.version++;
            tui.requestRender();
            return;
          }

          if (matchesKey(key, 'left') || matchesKey(key, 'right')) {
            const item = this.visibleItems[this.selectedIndex];
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
                (config as Record<string, unknown>)[item.key] = newValue;
                this.version++;
                tui.requestRender();
              }
            } else if (item.type === 'boolean') {
              (config as Record<string, unknown>)[item.key] = !(config as Record<string, unknown>)[item.key];
              this.clampSelection();
              this.version++;
              tui.requestRender();
            } else if (item.type === 'string') {
              if (item.options) {
                const currentIdx = item.options.indexOf(config[item.key] as string);
                const isRight = matchesKey(key, 'right');
                const nextIdx = isRight 
                  ? (currentIdx + 1) % item.options.length
                  : (currentIdx - 1 + item.options.length) % item.options.length;
                (config as Record<string, unknown>)[item.key] = item.options[nextIdx];
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
    } catch (e: any) {
      ctx.ui.notify(`Invalid config: ${e.message}`, 'error');
    }
  }
}

/**
 * Reset settings to defaults
 */
export function resetSettings(ctx: CommandContext): void {
  resetConfig();
  ctx.ui.notify('Settings reset to defaults (reload required)', 'warning');
}