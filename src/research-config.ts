/**
 * Research Configuration Command
 *
 * Consolidated command that provides:
 * - Health Management (run, history, clear, configure)
 * - Error Reporting (view, clear, export, configure)
 * - Knowledge Store (status, migrate, clear, configure)
 * - System Settings (view, modify, reset, save/load)
 * - Metrics & Monitoring (view, enable/disable, configure)
 *
 * Usage:
 * - /research-config                    - Opens interactive TUI menu
 * - /research-config <section>          - Direct access to section (e.g., health)
 * - /research-config <section> <action> - Direct action (e.g., health run)
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { visibleWidth, truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import { logger } from './logger.ts';
import * as fss from 'node:fs';
import * as pathmod from 'node:path';
import * as os from 'node:os';
import { healthRegistry, clearHealthCheckCache } from './healthcheck/index.ts';
import { getHealthHistory, getHealthSummary } from './healthcheck/persistence.ts';
import { errorTracker } from './utils/error-tracker.ts';
import {
  shutdownKnowledgeStore,
  initKnowledgeStore,
  isKnowledgeStoreReady,
  getStore,
  SUPPORTED_MODELS,
  clearKnowledgeStore,
} from './knowledge/index.ts';
import { getConfig, validateConfig, saveConfig, resetConfig, getEnvFilePath, getDbDir } from './config.ts';
import { metrics } from './utils/metrics.ts';

// ============================================================================
// Types and Interfaces
// ============================================================================

export type MenuSection = 'main' | 'health' | 'errors' | 'knowledge' | 'settings' | 'metrics';

export interface MenuItem {
  id: string;
  label: string;
  description: string;
  action?: () => Promise<void> | void;
  submenu?: MenuSection;
  hidden?: () => boolean;
}

export interface CommandArgs {
  section?: string;
  action?: string;
  params?: string[];
}

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Main command handler for /research-config
 */
export async function handleResearchConfigCommand(
  args: string,
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  const parsed = parseCommandArgs(args);

  // If no arguments, show interactive TUI
  if (!parsed.section) {
    await showInteractiveMenu(ctx, pi);
    return;
  }

  // Direct action routing
  await routeDirectAction(parsed, ctx, pi);
}

/**
 * Parse command arguments into section, action, and params
 */
function parseCommandArgs(args: string): CommandArgs {
  const parts = args.trim().split(/\s+/).filter(p => p);
  if (parts.length === 0) {
    return {};
  }

  return {
    section: parts[0],
    action: parts[1],
    params: parts.slice(2),
  };
}

/**
 * Route direct action to appropriate handler
 */
async function routeDirectAction(
  parsed: CommandArgs,
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  const section = parsed.section;
  const action = parsed.action;
  const params = parsed.params || [];

  // New section-based routing (Preferred)
  const knownSections = ['health', 'errors', 'knowledge', 'settings', 'metrics'];
  
  if (section && knownSections.includes(section)) {
    switch (section) {
      case 'health':
        await handleHealthAction(action, params, ctx, pi);
        break;
      case 'errors':
        await handleErrorsAction(action, params, ctx, pi);
        break;
      case 'knowledge':
        await handleKnowledgeAction(action, params, ctx, pi);
        break;
      case 'settings':
        await handleSettingsAction(action, params, ctx, pi);
        break;
      case 'metrics':
        await handleMetricsAction(action, params, ctx, pi);
        break;
    }
    return;
  }

  // Map old command names to new equivalents (backward compatibility)
  const commandMap: Record<string, () => Promise<void>> = {
    'health-clear': () => {
      clearHealthCheckCache();
      ctx.ui.notify('Health check cache cleared', 'info');
      return Promise.resolve();
    },
    'health-history': () => showHealthHistory(ctx, pi),
    'errors-clear': () => {
      errorTracker.clear();
      ctx.ui.notify('Error history cleared', 'info');
      return Promise.resolve();
    },
    'errors-export': () => exportErrorReport(params[0], ctx),
    'knowledge-migrate': () => handleKnowledgeMigration(params[0], ctx),
  };

  // Check for backward compatibility aliases
  if (section && commandMap[section]) {
    await commandMap[section]();
    return;
  }

  if (section) {
    ctx.ui.notify(`Unknown section: ${section}. Use /research-config for help.`, 'error');
  }
}

// ============================================================================
// Health Management Actions
// ============================================================================

async function handleHealthAction(
  action: string | undefined,
  _params: string[],
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'run':
    case undefined:
      await runHealthCheck(ctx, pi);
      break;
    case 'clear':
      clearHealthCheckCache();
      ctx.ui.notify('Health check cache cleared', 'info');
      break;
    case 'history':
      showHealthHistory(ctx, pi);
      break;
    case 'summary':
      showHealthSummary(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown health action: ${action}. Use: run, clear, history, summary`, 'error');
  }
}

async function runHealthCheck(ctx: any, pi: ExtensionAPI): Promise<void> {
  ctx.ui.notify('Running health checks...', 'info');

  try {
    const systemHealth = await healthRegistry.runAll();

    const outputLines: string[] = [];
    outputLines.push('## System Health Status');
    outputLines.push('');

    const statusIcon = systemHealth.status === 'healthy' ? '✅' :
                      systemHealth.status === 'degraded' ? '⚠️' : '❌';
    const statusText = systemHealth.status === 'healthy' ? 'All systems operational' :
                      systemHealth.status === 'degraded' ? 'System degraded (non-critical issues)' :
                      'System unhealthy (critical failures)';

    outputLines.push(`**${statusIcon} ${statusText}**`);
    outputLines.push('');

    for (const component of systemHealth.components) {
      const icon = component.healthy ? '✅' : '❌';
      const criticalMark = healthRegistry.isCritical(component.component) ? ' [CRITICAL]' : '';
      outputLines.push(`${icon} **${component.component}**${criticalMark}`);
      if (component.error) {
        outputLines.push(`  - Error: ${component.error}`);
      }
      if (component.diagnostic) {
        const diagnostics = Object.entries(component.diagnostic)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        if (diagnostics) {
          outputLines.push(`  - ${diagnostics}`);
        }
      }
      outputLines.push(`  - Duration: ${component.durationMs.toFixed(0)}ms`);
      outputLines.push('');
    }

    outputLines.push(`Checked at: ${new Date(systemHealth.timestamp).toLocaleString()}`);

    pi.sendMessage({
      customType: 'health-result',
      content: outputLines.join('\n'),
      display: true,
      details: { health: systemHealth },
    });

    ctx.ui.notify(`Health check complete: ${systemHealth.status}`, systemHealth.status === 'healthy' ? 'info' : 'warning');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[pi-research] Health check failed:', error);

    pi.sendMessage({
      customType: 'health-result',
      content: `**Health check failed**\n\n${message}`,
      display: true,
    });

    ctx.ui.notify(`❌ Health check failed: ${message}`, 'error');
  }
}

async function showHealthHistory(ctx: any, pi: ExtensionAPI): Promise<void> {
  const summary = getHealthSummary();
  const history = getHealthHistory(15);

  const outputLines: string[] = [];
  outputLines.push('## Health Check Statistics');
  outputLines.push('');
  outputLines.push(`- **Total checks:** ${summary.total}`);
  outputLines.push(`- **Healthy:** ${summary.healthy}`);
  outputLines.push(`- **Degraded:** ${summary.degraded}`);
  outputLines.push(`- **Unhealthy:** ${summary.unhealthy}`);
  outputLines.push(`- **Last check:** ${summary.lastCheck ? new Date(summary.lastCheck).toLocaleString() : 'Never'}`);
  outputLines.push(`- **Last status:** ${summary.lastStatus?.toUpperCase() || 'Unknown'}`);
  outputLines.push('');

  if (history.length > 0) {
    outputLines.push('## Recent Checks (Last 15)');
    outputLines.push('');
    for (const entry of history) {
      const icon = entry.status === 'healthy' ? '✅' :
                  entry.status === 'degraded' ? '⚠️' : '❌';
      const time = new Date(entry.timestamp).toLocaleTimeString();
      outputLines.push(`${icon} **${entry.status.toUpperCase()}** — ${time}`);

      const failedComponents = entry.components.filter(c => !c.healthy);
      if (failedComponents.length > 0) {
        outputLines.push(`  Failed: ${failedComponents.map(c => c.component).join(', ')}`);
      }
      outputLines.push('');
    }
  } else {
    outputLines.push('_No health check history available._');
  }

  pi.sendMessage({
    customType: 'health-history-result',
    content: outputLines.join('\n'),
    display: true,
    details: { summary, history },
  });

  ctx.ui.notify(`Health history: ${summary.total} checks recorded`, 'info');
}

async function showHealthSummary(_ctx: any, pi: ExtensionAPI): Promise<void> {
  const summary = getHealthSummary();

  const outputLines: string[] = [];
  outputLines.push('## Health Summary');
  outputLines.push('');
  outputLines.push(`Total checks: ${summary.total}`);
  outputLines.push(`Healthy: ${summary.healthy} (${summary.total > 0 ? ((summary.healthy / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push(`Degraded: ${summary.degraded} (${summary.total > 0 ? ((summary.degraded / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push(`Unhealthy: ${summary.unhealthy} (${summary.total > 0 ? ((summary.unhealthy / summary.total) * 100).toFixed(1) : 0}%)`);
  outputLines.push('');
  if (summary.lastCheck) {
    outputLines.push(`Last check: ${new Date(summary.lastCheck).toLocaleString()}`);
    outputLines.push(`Last status: ${summary.lastStatus?.toUpperCase() || 'Unknown'}`);
  }

  pi.sendMessage({
    customType: 'health-summary-result',
    content: outputLines.join('\n'),
    display: true,
    details: { summary },
  });
}

// ============================================================================
// Error Reporting Actions
// ============================================================================

async function handleErrorsAction(
  action: string | undefined,
  _params: string[],
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'view':
    case undefined:
      showErrorReport(ctx, pi);
      break;
    case 'clear':
      errorTracker.clear();
      ctx.ui.notify('Error history cleared', 'info');
      break;
    case 'export':
      await exportErrorReport(_params[0], ctx);
      break;
    case 'patterns':
      showErrorPatterns(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown errors action: ${action}. Use: view, clear, export, patterns`, 'error');
  }
}

async function showErrorReport(ctx: any, pi: ExtensionAPI): Promise<void> {
  const report = errorTracker.getReport();

  const outputLines: string[] = [];
  outputLines.push('## Error Report');
  outputLines.push('');
  outputLines.push(`- **Total errors:** ${report.totalErrors}`);
  outputLines.push(`- **Unique patterns:** ${report.uniquePatterns}`);
  outputLines.push('');

  if (report.patterns.length > 0) {
    outputLines.push('## Error Patterns (sorted by frequency)');
    outputLines.push('');
    for (const pattern of report.patterns) {
      outputLines.push(`### ${pattern.signature}`);
      outputLines.push(`**Count:** ${pattern.count} | **First seen:** ${new Date(pattern.firstSeen).toLocaleString()} | **Last seen:** ${new Date(pattern.lastSeen).toLocaleString()}`);
      outputLines.push('');
      outputLines.push('**Example message:**');
      outputLines.push('```' + pattern.message.substring(0, 200) + (pattern.message.length > 200 ? '...' : '') + '```');
      outputLines.push('');
      if (pattern.contexts.length > 0) {
        outputLines.push('**Recent contexts:**');
        for (const context of pattern.contexts.slice(-3)) {
          const contextParts = Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ');
          outputLines.push(`- ${contextParts}`);
        }
        outputLines.push('');
      }
    }
  } else {
    outputLines.push('_No errors recorded._');
  }

  pi.sendMessage({
    customType: 'error-report',
    content: outputLines.join('\n'),
    display: true,
    details: report,
  });

  ctx.ui.notify(`Error report: ${report.totalErrors} errors, ${report.uniquePatterns} patterns`, 'info');
}

async function showErrorPatterns(_ctx: any, pi: ExtensionAPI): Promise<void> {
  const report = errorTracker.getReport();

  const outputLines: string[] = [];
  outputLines.push('## Error Patterns Summary');
  outputLines.push('');
  outputLines.push(`Total unique patterns: ${report.uniquePatterns}`);
  outputLines.push('');

  if (report.patterns.length > 0) {
    outputLines.push('| Pattern | Count | Last Seen |');
    outputLines.push('|---------|-------|-----------|');
    for (const pattern of report.patterns.slice(0, 10)) {
      const lastSeen = new Date(pattern.lastSeen).toLocaleDateString();
      outputLines.push(`| ${pattern.signature.substring(0, 40)} | ${pattern.count} | ${lastSeen} |`);
    }
  } else {
    outputLines.push('_No error patterns recorded._');
  }

  pi.sendMessage({
    customType: 'error-patterns-result',
    content: outputLines.join('\n'),
    display: true,
    details: { patterns: report.patterns },
  });
}

async function exportErrorReport(customPath: string | undefined, ctx: any): Promise<void> {
  const report = errorTracker.getReport();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  
  let exportPath: string;
  if (customPath) {
    exportPath = pathmod.resolve(ctx.cwd, customPath);
    if (!exportPath.endsWith('.json')) {
      exportPath += '.json';
    }
  } else {
    const xdgCacheBase = process.env['XDG_CACHE_HOME'] || pathmod.join(os.homedir(), '.cache');
    const errorReportsDir = pathmod.join(xdgCacheBase, 'pi-research', 'error-reports');
    if (!fss.existsSync(errorReportsDir)) {
      fss.mkdirSync(errorReportsDir, { recursive: true });
    }
    exportPath = pathmod.join(errorReportsDir, `error-report-${timestamp}.json`);
  }

  try {
    const exportData = {
      exportedAt: new Date().toISOString(),
      summary: {
        totalErrors: report.totalErrors,
        uniquePatterns: report.uniquePatterns,
      },
      patterns: report.patterns.map(p => ({
        signature: p.signature,
        message: p.message,
        count: p.count,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        contexts: p.contexts.map(c => {
          const safeContext: Record<string, string> = {};
          for (const [key, value] of Object.entries(c)) {
            if (['researchId', 'mode', 'component', 'operation'].includes(key)) {
              safeContext[key] = String(value);
            }
          }
          return safeContext;
        }),
      })),
    };

    fss.writeFileSync(exportPath, JSON.stringify(exportData, null, 2), 'utf-8');
    
    const relativePath = pathmod.relative(ctx.cwd, exportPath);
    ctx.ui.notify(`Error report exported to: ${relativePath}`, 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to export error report: ${message}`, 'error');
  }
}

// ============================================================================
// Knowledge Store Actions
// ============================================================================

async function handleKnowledgeAction(
  action: string | undefined,
  _params: string[],
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'status':
    case undefined:
      showKnowledgeStatus(ctx, pi);
      break;
    case 'migrate':
      await handleKnowledgeMigration(_params[0], ctx);
      break;
    case 'clear':
      await clearKnowledgeStore();
      ctx.ui.notify('Knowledge store cleared', 'info');
      break;
    case 'count':
      await showKnowledgeCount(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown knowledge action: ${action}. Use: status, migrate, clear, count`, 'error');
  }
}

async function showKnowledgeStatus(ctx: any, pi: ExtensionAPI): Promise<void> {
  const config = getConfig();
  const outputLines: string[] = [];
  
  outputLines.push('## Knowledge Store Status');
  outputLines.push('');
  outputLines.push(`**Enabled:** ${config.KNOWLEDGE_STORE_ENABLED ? 'Yes' : 'No'}`);
  outputLines.push(`**Model:** ${config.EMBEDDING_MODEL}`);
  outputLines.push(`**Device:** ${config.EMBEDDING_DEVICE}`);
  outputLines.push(`**Cache TTL:** ${config.KNOWLEDGE_STORE_CACHE_TTL_DAYS} days`);
  outputLines.push('');

  if (config.KNOWLEDGE_STORE_ENABLED) {
    const ready = isKnowledgeStoreReady();
    outputLines.push(`**Status:** ${ready ? 'Ready' : 'Not initialized'}`);
    
    if (ready) {
      try {
        const store = await getStore();
        const count = await store.count();
        outputLines.push(`**Entries:** ${count}`);
      } catch (_error) {
        outputLines.push(`**Entries:** Error retrieving count`);
      }
    }
  }

  outputLines.push('');
  outputLines.push(`**Database directory:** ${getDbDir()}`);

  pi.sendMessage({
    customType: 'knowledge-status-result',
    content: outputLines.join('\n'),
    display: true,
  });

  ctx.ui.notify('Knowledge store status displayed', 'info');
}

async function handleKnowledgeMigration(strategy: string | undefined, ctx: any): Promise<void> {
  const validStrategies = ['drop', 're-embed', 'continue'];
  
  if (!strategy || !validStrategies.includes(strategy)) {
    ctx.ui.notify(`Usage: /research-config knowledge migrate <${validStrategies.join('|')}>`, 'error');
    return;
  }
  
  ctx.ui.notify(`Starting knowledge store migration with strategy: ${strategy}...`, 'info');
  
  try {
    process.env['PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY'] = strategy;
    
    await shutdownKnowledgeStore();
    await initKnowledgeStore();
    
    delete process.env['PI_KNOWLEDGE_STORE_MIGRATION_STRATEGY'];
    
    ctx.ui.notify(`Knowledge store migration complete: ${strategy}`, 'info');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[pi-research] Knowledge store migration failed:', error);
    ctx.ui.notify(`❌ Migration failed: ${message}`, 'error');
  }
}

async function showKnowledgeCount(ctx: any, pi: ExtensionAPI): Promise<void> {
  if (!isKnowledgeStoreReady()) {
    ctx.ui.notify('Knowledge store is not ready', 'warning');
    return;
  }

  try {
    const store = await getStore();
    const count = await store.count();

    pi.sendMessage({
      customType: 'knowledge-count-result',
      content: `**Knowledge Store Entries:** ${count}`,
      display: true,
      details: { count },
    });

    ctx.ui.notify(`Knowledge store has ${count} entries`, 'info');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to retrieve knowledge store count: ${message}`, 'error');
  }
}

// ============================================================================
// Settings Actions
// ============================================================================

async function handleSettingsAction(
  action: string | undefined,
  _params: string[],
  ctx: any,
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

async function showSettings(ctx: any, pi: ExtensionAPI): Promise<void> {
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

async function showSettingsEditor(ctx: any, _pi: ExtensionAPI): Promise<void> {
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

  // Fetch knowledge store entry count
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
                (config[item.key] as any) = newValue;
                this.version++;
                tui.requestRender();
              }
            } else if (item.type === 'boolean') {
              (config[item.key] as any) = !config[item.key];
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
}

function resetSettings(ctx: any): void {
  resetConfig();
  ctx.ui.notify('Settings reset to defaults (reload required)', 'warning');
}

// ============================================================================
// Metrics Actions
// ============================================================================

async function handleMetricsAction(
  action: string | undefined,
  _params: string[],
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  switch (action) {
    case 'view':
    case undefined:
      showMetrics(ctx, pi);
      break;
    default:
      ctx.ui.notify(`Unknown metrics action: ${action}. Use: view`, 'error');
  }
}

async function showMetrics(ctx: any, pi: ExtensionAPI): Promise<void> {
  const metricsData = metrics.getSnapshot();
  const outputLines: string[] = [];
  
  outputLines.push('## System Metrics');
  outputLines.push('');
  
  if (Object.keys(metricsData).length === 0) {
    outputLines.push('_No metrics available._');
  } else {
    for (const [key, value] of Object.entries(metricsData)) {
      outputLines.push(`**${key}:** ${typeof value === 'number' ? value.toFixed(2) : JSON.stringify(value)}`);
    }
  }

  pi.sendMessage({
    customType: 'metrics-result',
    content: outputLines.join('\n'),
    display: true,
    details: { metrics: metricsData },
  });

  ctx.ui.notify('Metrics displayed', 'info');
}

// ============================================================================
// Interactive TUI Menu
// ============================================================================

/**
 * Show interactive TUI menu for research configuration
 */
async function showInteractiveMenu(ctx: any, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('Interactive menu requires UI mode', 'error');
    return;
  }

  const result = await ctx.ui.custom(
    (tui: any, theme: any, _kb: any, done: (val: any) => void) => {
      class ResearchConfigMenu {
        private currentSection: MenuSection = 'main';
        private selectedIndex: number = 0;
        private cachedLines: string[] = [];
        private cachedWidth = 0;
        private cachedVersion = -1;
        private version = 0;
        private statusMessage = '';
        private statusMessageTimeout: NodeJS.Timeout | null = null;

        private menus: Record<MenuSection, MenuItem[]> = {
          main: [
            { id: 'health', label: 'Health Management', description: 'System health checks and monitoring', submenu: 'health' },
            { id: 'errors', label: 'Error Reporting', description: 'View and manage error reports', submenu: 'errors' },
            { id: 'knowledge', label: 'Knowledge Store', description: 'Manage persistent memory', submenu: 'knowledge' },
            { id: 'settings', label: 'System Settings', description: 'View and modify configuration', submenu: 'settings' },
            { id: 'metrics', label: 'Metrics & Monitoring', description: 'View system metrics', submenu: 'metrics' },
          ],
          health: [
            { id: 'run', label: 'Run Health Check', description: 'Execute all health checks', action: async () => {
              this.showStatus('Running health check...');
              await runHealthCheck({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'history', label: 'View History', description: 'Show recent health check results', action: async () => {
              this.showStatus('Loading health history...');
              await showHealthHistory({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'summary', label: 'View Summary', description: 'Show health statistics', action: async () => {
              this.showStatus('Loading health summary...');
              await showHealthSummary({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'clear', label: 'Clear Cache', description: 'Clear health check cache', action: async () => {
              clearHealthCheckCache();
              this.showStatus('Health check cache cleared');
              setTimeout(() => this.clearStatus(), 2000);
            }},
            { id: 'back', label: '← Back to Main', description: 'Return to main menu', action: () => {
              this.currentSection = 'main';
              this.selectedIndex = 0;
            }},
          ],
          errors: [
            { id: 'view', label: 'View Error Report', description: 'Show all errors and patterns', action: async () => {
              this.showStatus('Loading error report...');
              await showErrorReport({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'patterns', label: 'View Patterns', description: 'Show error patterns summary', action: async () => {
              this.showStatus('Loading error patterns...');
              await showErrorPatterns({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'export', label: 'Export Report', description: 'Export errors to JSON file', action: async () => {
              await exportErrorReport(undefined, ctx);
              this.showStatus('Error report exported');
              setTimeout(() => this.clearStatus(), 2000);
            }},
            { id: 'clear', label: 'Clear History', description: 'Clear all error history', action: async () => {
              errorTracker.clear();
              this.showStatus('Error history cleared');
              setTimeout(() => this.clearStatus(), 2000);
            }},
            { id: 'back', label: '← Back to Main', description: 'Return to main menu', action: () => {
              this.currentSection = 'main';
              this.selectedIndex = 0;
            }},
          ],
          knowledge: [
            { id: 'status', label: 'View Status', description: 'Show knowledge store status', action: async () => {
              this.showStatus('Loading knowledge store status...');
              await showKnowledgeStatus({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'count', label: 'View Entry Count', description: 'Show number of stored entries', action: async () => {
              this.showStatus('Loading entry count...');
              await showKnowledgeCount({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'migrate', label: 'Migrate Data', description: 'Migrate knowledge store (requires reload)', action: async () => {
              // Show migration submenu (handled by direct action)
              done({ type: 'submenu', section: 'knowledge-migrate' });
            }},
            { id: 'clear', label: 'Clear Store', description: 'Delete all knowledge store data', action: async () => {
              await clearKnowledgeStore();
              this.showStatus('Knowledge store cleared');
              setTimeout(() => this.clearStatus(), 2000);
            }},
            { id: 'back', label: '← Back to Main', description: 'Return to main menu', action: () => {
              this.currentSection = 'main';
              this.selectedIndex = 0;
            }},
          ],
          settings: [
            { id: 'view', label: 'View Settings', description: 'Show current configuration', action: async () => {
              this.showStatus('Loading settings...');
              await showSettings({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'edit', label: 'Edit Settings', description: 'Interactive configuration editor', action: async () => {
              this.showStatus('Opening settings editor...');
              await showSettingsEditor(ctx, pi);
              this.clearStatus();
            }},
            { id: 'reset', label: 'Reset to Defaults', description: 'Reset all settings to defaults', action: () => {
              resetSettings(ctx);
              this.showStatus('Settings reset (reload required)');
              setTimeout(() => this.clearStatus(), 3000);
            }},
            { id: 'back', label: '← Back to Main', description: 'Return to main menu', action: () => {
              this.currentSection = 'main';
              this.selectedIndex = 0;
            }},
          ],
          metrics: [
            { id: 'view', label: 'View Metrics', description: 'Show system metrics', action: async () => {
              this.showStatus('Loading metrics...');
              await showMetrics({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'back', label: '← Back to Main', description: 'Return to main menu', action: () => {
              this.currentSection = 'main';
              this.selectedIndex = 0;
            }},
          ],
        };

        private get visibleItems(): MenuItem[] {
          return this.menus[this.currentSection].filter(item => !item.hidden?.());
        }

        private showStatus(message: string): void {
          this.statusMessage = message;
          this.version++;
          tui.requestRender();
          
          if (this.statusMessageTimeout) {
            clearTimeout(this.statusMessageTimeout);
          }
        }

        private clearStatus(): void {
          this.statusMessage = '';
          this.version++;
          tui.requestRender();
        }

        render(width: number): string[] {
          if (this.cachedWidth === width && this.cachedVersion === this.version) {
            return this.cachedLines;
          }

          const lines: string[] = [];
          const sep = theme.fg('accent', '─'.repeat(Math.max(0, width - 2)));

          // Header
          const sectionTitle = this.currentSection === 'main' 
            ? 'Research Configuration'
            : `${this.currentSection.charAt(0).toUpperCase() + this.currentSection.slice(1)} Management`;
          lines.push(theme.fg('accent', ` ${sectionTitle}`));
          lines.push(sep);

          // Menu items
          const items = this.visibleItems;
          items.forEach((item, idx) => {
            const isSelected = idx === this.selectedIndex;
            const prefix = isSelected ? theme.fg('accent', '► ') : '  ';
            const label = isSelected ? theme.fg('accent', item.label) : item.label;
            const desc = theme.fg('muted', ` — ${item.description}`);
            
            const line = `${prefix}${label}${desc}`;
            lines.push(truncateToWidth(line, Math.max(1, width - 2)));
          });

          lines.push(sep);

          // Status message
          if (this.statusMessage) {
            lines.push(theme.fg('success', ` ${this.statusMessage}`));
          }

          // Footer
          const helpText = this.currentSection === 'main'
            ? '↑↓ Navigate  [Enter] Select  [Esc] Exit'
            : '↑↓ Navigate  [Enter] Execute  [Esc] Back';
          lines.push(theme.fg('muted', ` ${helpText}`));

          // Version tracking for caching
          this.cachedLines = lines;
          this.cachedWidth = width;
          this.cachedVersion = this.version;

          return this.cachedLines;
        }

        async handleInput(key: string): Promise<void> {
          // Escape
          if (matchesKey(key, 'escape')) {
            if (this.currentSection === 'main') {
              done({ type: 'cancel' });
            } else {
              this.currentSection = 'main';
              this.selectedIndex = 0;
              this.version++;
              tui.requestRender();
            }
            return;
          }

          // Enter
          if (key === '\r' || key === '\n') {
            const item = this.visibleItems[this.selectedIndex];
            if (!item) return;

            if (item.submenu) {
              this.currentSection = item.submenu;
              this.selectedIndex = 0;
              this.version++;
              tui.requestRender();
            } else if (item.action) {
              await item.action();
            }
            return;
          }

          // Up/Down arrows
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
        }

        invalidate(): void {
          this.cachedVersion = -1;
        }
      }

      return new ResearchConfigMenu();
    },
  );

  // Handle special submenu results
  if (result?.type === 'submenu' && result.section === 'knowledge-migrate') {
    // Show migration options in a follow-up dialog or return to main
    ctx.ui.notify('Use: /research-config knowledge migrate <drop|re-embed|continue>', 'info');
  }
}