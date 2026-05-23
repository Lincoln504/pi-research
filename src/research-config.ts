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
import { truncateToWidth, matchesKey } from '@mariozechner/pi-tui';
import type { MenuSection, MenuItem, CommandArgs } from './config-registry.ts';
import { parseCommandArgs, KNOWN_SECTIONS as knownSections } from './config-registry.ts';
import * as healthModule from './commands/health-command.ts';
import * as errorsModule from './commands/errors-command.ts';
import * as knowledgeModule from './commands/knowledge-command.ts';
import * as settingsModule from './commands/settings-command.ts';
import * as metricsModule from './commands/metrics-command.ts';

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
  if (section && knownSections.includes(section as any)) {
    switch (section) {
      case 'health':
        await healthModule.handleHealthAction(action, params, ctx, pi);
        break;
      case 'errors':
        await errorsModule.handleErrorsAction(action, params, ctx, pi);
        break;
      case 'knowledge':
        await knowledgeModule.handleKnowledgeAction(action, params, ctx, pi);
        break;
      case 'settings':
        await settingsModule.handleSettingsAction(action, params, ctx, pi);
        break;
      case 'metrics':
        await metricsModule.handleMetricsAction(action, params, ctx, pi);
        break;
    }
    return;
  }

  // Map old command names to new equivalents (backward compatibility)
  const commandMap: Record<string, () => Promise<void>> = {
    'health-clear': () => {
      healthModule.clearHealthCache(ctx);
      return Promise.resolve();
    },
    'health-history': () => {
      healthModule.showHealthHistory(ctx, pi);
      return Promise.resolve();
    },
    'errors-clear': () => {
      errorsModule.clearErrorHistory(ctx);
      return Promise.resolve();
    },
    'errors-export': () => {
      errorsModule.exportErrorReport(params[0], ctx);
      return Promise.resolve();
    },
    'knowledge-migrate': () => {
      knowledgeModule.handleKnowledgeMigration(params[0], ctx);
      return Promise.resolve();
    },
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
// Health Management Actions (delegated to health-command module)
// ============================================================================

export { handleHealthAction, runHealthCheck, showHealthHistory, showHealthSummary, clearHealthCache } from './commands/health-command.ts';

// ============================================================================
// Error Reporting Actions (delegated to errors-command module)
// ============================================================================

export { handleErrorsAction, showErrorReport, showErrorPatterns, exportErrorReport, clearErrorHistory } from './commands/errors-command.ts';

// ============================================================================
// Knowledge Store Actions (delegated to knowledge-command module)
// ============================================================================

export { handleKnowledgeAction, showKnowledgeStatus, handleKnowledgeMigration, showKnowledgeCount } from './commands/knowledge-command.ts';

// ============================================================================
// Settings Actions (delegated to settings-command module)
// ============================================================================

export { handleSettingsAction, showSettings, showSettingsEditor, resetSettings } from './commands/settings-command.ts';

// ============================================================================
// Metrics Actions (delegated to metrics-command module)
// ============================================================================

export { handleMetricsAction, showMetrics } from './commands/metrics-command.ts';

// ============================================================================
// Interactive TUI Menu
// ============================================================================

import { clearKnowledgeStore } from './knowledge/index.ts';

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
              await healthModule.runHealthCheck({ ui: ctx.ui, hasUI: ctx.hasUI ?? false }, pi);
              this.clearStatus();
            }},
            { id: 'history', label: 'View History', description: 'Show recent health check results', action: async () => {
              this.showStatus('Loading health history...');
              await healthModule.showHealthHistory({ ui: ctx.ui, hasUI: ctx.hasUI ?? false }, pi);
              this.clearStatus();
            }},
            { id: 'summary', label: 'View Summary', description: 'Show health statistics', action: async () => {
              this.showStatus('Loading health summary...');
              await healthModule.showHealthSummary({ ui: ctx.ui, hasUI: ctx.hasUI ?? false }, pi);
              this.clearStatus();
            }},
            { id: 'clear', label: 'Clear Cache', description: 'Clear health check cache', action: async () => {
              healthModule.clearHealthCache({ ui: ctx.ui, hasUI: ctx.hasUI ?? false });
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
              await errorsModule.showErrorReport({ ui: ctx.ui, cwd: ctx.cwd }, pi);
              this.clearStatus();
            }},
            { id: 'patterns', label: 'View Patterns', description: 'Show error patterns summary', action: async () => {
              this.showStatus('Loading error patterns...');
              await errorsModule.showErrorPatterns({ ui: ctx.ui, cwd: ctx.cwd }, pi);
              this.clearStatus();
            }},
            { id: 'export', label: 'Export Report', description: 'Export errors to JSON file', action: async () => {
              await errorsModule.exportErrorReport(undefined, { ui: ctx.ui, cwd: ctx.cwd });
              this.showStatus('Error report exported');
              setTimeout(() => this.clearStatus(), 2000);
            }},
            { id: 'clear', label: 'Clear History', description: 'Clear all error history', action: async () => {
              errorsModule.clearErrorHistory({ ui: ctx.ui, cwd: ctx.cwd });
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
              await knowledgeModule.showKnowledgeStatus({ ui: ctx.ui }, pi);
              this.clearStatus();
            }},
            { id: 'count', label: 'View Entry Count', description: 'Show number of stored entries', action: async () => {
              this.showStatus('Loading entry count...');
              await knowledgeModule.showKnowledgeCount({ ui: ctx.ui }, pi);
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
              await settingsModule.showSettings({ ui: ctx.ui, hasUI: ctx.hasUI ?? false, cwd: ctx.cwd }, pi);
              this.clearStatus();
            }},
            { id: 'edit', label: 'Edit Settings', description: 'Interactive configuration editor', action: async () => {
              this.showStatus('Opening settings editor...');
              await settingsModule.showSettingsEditor(ctx, pi);
              this.clearStatus();
            }},
            { id: 'reset', label: 'Reset to Defaults', description: 'Reset all settings to defaults', action: () => {
              settingsModule.resetSettings({ ui: ctx.ui, hasUI: ctx.hasUI ?? false, cwd: ctx.cwd });
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
              await metricsModule.showMetrics({ ui: ctx.ui }, pi);
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