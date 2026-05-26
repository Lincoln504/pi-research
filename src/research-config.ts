/**
 * Research Configuration Command
 *
 * Consolidated command that provides:
 * - Health Management (run)
 * - Knowledge Store (status, migrate, clear, configure)
 * - System Settings (view, modify, reset, save/load)
 * - Metrics & Monitoring (view, enable/disable, configure)
 *
 * Usage:
 * - /research-config                    - Opens interactive TUI menu
 * - /research-config <section>          - Direct access to section (e.g., health)
 * - /research-config <section> <action> - Direct action (e.g., health run)
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { matchesKey, SelectList, Box, type SelectItem } from '@earendil-works/pi-tui';
import { parseCommandArgs, KNOWN_SECTIONS as knownSections } from './config-registry.ts';
import type { ConfigSection } from './types/index.ts';
import * as healthModule from './commands/health-command.ts';
import * as knowledgeModule from './commands/knowledge-command.ts';
import * as settingsModule from './commands/settings-command.ts';
import * as metricsModule from './commands/metrics-command.ts';
import { clearKnowledgeStore } from './knowledge/index.ts';

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
  parsed: any,
  ctx: any,
  pi: ExtensionAPI
): Promise<void> {
  const section = parsed.section;
  const action = parsed.action;
  const params = parsed.params || [];

  // New section-based routing (Preferred)
  if (section && (knownSections as readonly string[]).includes(section as ConfigSection)) {
    switch (section) {
      case 'health':
        await healthModule.handleHealthAction(action, params, ctx, pi);
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

  if (section) {
    ctx.ui.notify(`Unknown section: ${section}. Use /research-config for help.`, 'error');
  }
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
      const selectTheme = {
        selectedPrefix: (text: string) => theme.fg('accent', '► ' + text),
        selectedText: (text: string) => theme.fg('accent', text),
        description: (text: string) => theme.fg('muted', text),
        scrollInfo: (text: string) => theme.fg('muted', text),
        noMatch: (text: string) => theme.fg('error', text),
      };

      const sections: Record<string, { title: string, items: SelectItem[] }> = {
        main: {
          title: 'Research Configuration',
          items: [
            { value: 'health', label: 'Health Management', description: 'System health checks and monitoring' },
            { value: 'knowledge', label: 'Knowledge Store', description: 'Manage persistent memory' },
            { value: 'settings', label: 'System Settings', description: 'View and modify configuration' },
            { value: 'metrics', label: 'Metrics & Monitoring', description: 'View system metrics' },
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
            { value: 'count', label: 'View Entry Count', description: 'Show number of stored entries' },
            { value: 'clear', label: 'Clear Store', description: 'Delete all knowledge store data' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        settings: {
          title: 'System Settings',
          items: [
            { value: 'view', label: 'View Settings Summary', description: 'Show current configuration' },
            { value: 'edit', label: 'Open Settings Editor', description: 'Interactive configuration editor' },
            { value: 'back', label: '← Back to Main', description: 'Return to main menu' },
          ]
        },
        metrics: {
          title: 'Metrics & Monitoring',
          items: [
            { value: 'view', label: 'View Metrics', description: 'Show system metrics' },
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
                // Execute action
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
      case 'health':
        if (action === 'run') await healthModule.runHealthCheck({ ui: ctx.ui, hasUI: ctx.hasUI ?? false }, pi);
        break;
      case 'knowledge':
        if (action === 'status') await knowledgeModule.showKnowledgeStatus({ ui: ctx.ui }, pi);
        else if (action === 'count') await knowledgeModule.showKnowledgeCount({ ui: ctx.ui }, pi);
        else if (action === 'clear') await clearKnowledgeStore();
        break;
      case 'settings':
        if (action === 'view') await settingsModule.showSettingsSummary({ ui: ctx.ui }, pi);
        else if (action === 'edit') await settingsModule.showSettingsEditor(ctx, pi);
        break;
      case 'metrics':
        if (action === 'view') await metricsModule.showMetrics({ ui: ctx.ui }, pi);
        break;
    }
  }

  // Handle special submenu results
  if (result?.type === 'submenu' && result.section === 'knowledge-migrate') {
    // Show migration options in a follow-up dialog or return to main
    ctx.ui.notify('Use: /research-config knowledge migrate <drop|re-embed|continue>', 'info');
  }
}
