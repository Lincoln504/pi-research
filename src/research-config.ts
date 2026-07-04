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
import { normalizeSessionId } from './orchestration/session-state.ts';
import { getConfig, saveConfig, resetConfig, getDbDir } from './config.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getService, clearService, tryGetServiceContainerFromCtx } from './core/service-registry.ts';
import { ServiceNames, IKnowledgeStoreService } from './core/service-interfaces.ts';
// Type-only: avoids statically loading the native ML/vector stack into the
// extension load path. The value (clearEmbeddingInstance) is dynamically
// imported at its call sites, only when a knowledge command actually runs.
import type { KnowledgeStoreService } from './infrastructure/knowledge-store-service.ts';
import type { Theme } from './types/research-panel-types.ts';
// Import the constant directly from its source module rather than the knowledge
// barrel (./knowledge/index.ts), which would transitively load lancedb.
import { SUPPORTED_MODELS } from './knowledge/model-config.ts';
import { metrics } from './utils/metrics.ts';
import {
  extractRunStats,
  aggregateSessionStats,
  buildSessionOverview,
  buildRunCompactLine,
} from './utils/metrics-summary.ts';
import { logger } from './logger.ts';
import { formatTimeAgo, formatDuration } from './utils/text-utils.ts';
import { buildDefaultDebugLogPath } from './utils/log-utils.ts';
import {
  HARNESSES,
  installSkill,
  uninstallSkill,
  skillInstallCandidates,
  skillUninstallCandidates,
  SKILL_AGENT_TARGETS,
} from './skill-install/skill-installer.ts';
import * as path from 'node:path';

// ============================================================================
// Utilities
// ============================================================================

/**
 * TUI setting id → canonical env-var key written to config.env / the project
 * registry. Passed to saveConfig as `changedKeys` so a save persists ONLY the
 * setting the user actually changed — never a snapshot of the whole resolved
 * config (which would freeze env overrides and current defaults into the file).
 * Several ids do not map 1:1 (e.g. RESEARCHER_TIMEOUT_MS → PI_RESEARCH_TIMEOUT_MS),
 * hence an explicit map instead of `PI_RESEARCH_${id}`.
 */
const ENV_KEY_BY_SETTING_ID: Record<string, string> = {
  DEFAULT_RESEARCH_DEPTH: 'PI_RESEARCH_DEFAULT_RESEARCH_DEPTH',
  KNOWLEDGE_STORE_MODE: 'PI_RESEARCH_KNOWLEDGE_STORE_MODE',
  RESEARCHER_TIMEOUT_MS: 'PI_RESEARCH_TIMEOUT_MS',
  MAX_CONCURRENT_RESEARCHERS: 'PI_RESEARCH_MAX_RESEARCHERS',
  MAX_SCRAPE_BATCHES: 'PI_RESEARCH_MAX_SCRAPE_BATCHES',
  RESEARCH_REPORT_EXPORT_ENABLED: 'PI_RESEARCH_REPORT_EXPORT_ENABLED',
  DEBUG: 'PI_RESEARCH_DEBUG',
  EMBEDDING_MODEL: 'PI_RESEARCH_EMBEDDING_MODEL',
  EMBEDDING_DEVICE: 'PI_RESEARCH_EMBEDDING_DEVICE',
  KNOWLEDGE_STORE_CACHE_TTL_DAYS: 'PI_RESEARCH_CACHE_TTL_DAYS',
};

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
  // Ensure the global TUI controller is initialized. Normalize the session id (→ 'default'
  // when unresolved) like every other call site: initGlobalTuiController unconditionally sets
  // state.piSessionId, and an undefined value there makes setInteractiveTuiActive skip
  // hideMasterWidget/refreshAllSessions — leaving the live panel stacked under the menu.
  const piSessionId = normalizeSessionId((ctx as any).sessionId || (ctx as any).sessionManager?.getSessionId());
  initGlobalTuiController(ctx.ui, piSessionId);

  const cwd = ctx.cwd || process.cwd();
  const initialConfig = { ...getConfig(cwd) };
  const config = { ...getConfig(cwd) };
  const container = tryGetServiceContainerFromCtx(ctx);
  const depthLabels: Record<number, string> = { 1: 'normal', 2: 'deep', 3: 'ultra' };

  const anyKnowledgeStore = config.KNOWLEDGE_STORE_MODE !== 'none';

  // Coding-agent skill install/uninstall gating, computed once from disk:
  //  • Install is offered only when a target agent's ROOT config folder already
  //    exists (~/.claude or ~/.codex) — we never create an agent's home dir.
  //  • Uninstall is offered only when the skill is actually installed (an owned
  //    symlink/copy at ~/.<agent>/skills/pi-research) — a deeper-level check.
  const anyAgentRootPresent = skillInstallCandidates().length > 0;
  const skillInstalledAnywhere = skillUninstallCandidates().length > 0;

  const initialItems: SettingItem[] = [
    // ── Project-scoped settings (saved per-directory) ──
    {
      id: 'DEFAULT_RESEARCH_DEPTH',
      label: '/research depth [project]',
      description: 'Default depth for the /research command (normal, deep, ultra).\n[project] means configured independently per directory.',
      currentValue: depthLabels[config.DEFAULT_RESEARCH_DEPTH] || String(config.DEFAULT_RESEARCH_DEPTH),
      values: ['normal', 'deep', 'ultra'],
    },
    {
      id: 'KNOWLEDGE_STORE_MODE',
      label: 'Knowledge Mode [project]',
      description: 'Knowledge store scope — none (disabled), project (scope knowledge per this directory), or global (scope knowledge globally, shared across all projects).\n[project] means configured independently per directory.',
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
    // Browser Workers is intentionally NOT exposed here. It is an
    // environment-only setting (PI_RESEARCH_WORKER_THREADS, default 4) so that
    // CPU/RAM-sensitive concurrency is not casually changed from the menu.
    ...(anyKnowledgeStore ? [
      {
        id: 'EMBEDDING_MODEL',
        label: 'Embedding Model',
        description: 'Vector model for semantic search. Changing it clears the current knowledge store and starts fresh.',
        currentValue: config.EMBEDDING_MODEL.split('/').pop()!,
        values: SUPPORTED_MODELS.map(m => m.id.split('/').pop()!),
      },
      {
        id: 'EMBEDDING_DEVICE',
        label: 'Embedding Device',
        description: 'Hardware backend for the embedding model. GPU probes whether WebGPU actually runs on this machine and automatically falls back to CPU if it does not (safe everywhere). CPU forces CPU-only inference. (Raw forced-GPU is available via the PI_RESEARCH_EMBEDDING_DEVICE=webgpu env var for benchmarking.)',
        currentValue: config.EMBEDDING_DEVICE === 'cpu' ? 'CPU' : 'GPU',
        values: ['GPU', 'CPU'],
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
      description: `Write verbose diagnostics to ${buildDefaultDebugLogPath()} for troubleshooting.`,
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
      id: 'ACTION_METRICS',
      label: 'Session Metrics',
      description: 'Show token usage, API cost estimates, and success rates. You will be offered the option to reset counters after viewing.',
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

    // ── Coding-agent skill ──
    // Install only shows when a target agent's root config dir exists; uninstall
    // only shows when the skill is actually installed somewhere.
    ...(anyAgentRootPresent ? [
      {
        id: 'ACTION_SKILL_INSTALL',
        label: 'Install in External Agents',
        description: 'Symlink the pi-research skill into your other coding agents (Claude, Codex, OpenClaw) so they can run web research too. Only agents already set up on this machine are touched.',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
    ...(skillInstalledAnywhere ? [
      {
        id: 'ACTION_SKILL_UNINSTALL',
        label: 'Remove from External Agents',
        description: 'Remove the pi-research skill from your other coding agents (Claude, Codex, OpenClaw). Only the symlinks this extension created are removed; unrelated skills are left untouched.',
        currentValue: 'run',
        values: ['run'],
      },
    ] as SettingItem[] : []),
  ];

  setInteractiveTuiActive(true);
  try {
    await ctx.ui.custom(
      (_tui: TUI, theme: Theme, _kb: any, done: (val: any) => void) => {
        // The "[project]" tag marks settings that are saved independently per
        // directory. It is rendered in the warning (yellow) color so it stands
        // out, while the rest of the label keeps its normal/accent color. The
        // tag is embedded in the label text (SettingsList pads it for alignment),
        // so we split on it here rather than recoloring the whole padded string.
        const PROJECT_TAG = '[project]';
        const colorizeLabel = (text: string, selected: boolean): string => {
          const idx = text.indexOf(PROJECT_TAG);
          if (idx === -1) {
            return selected ? theme.fg('accent', text) : text;
          }
          const before = text.slice(0, idx);
          const after = text.slice(idx + PROJECT_TAG.length); // trailing alignment padding
          const beforeColored = before ? (selected ? theme.fg('accent', before) : before) : '';
          return `${beforeColored}${theme.fg('warning', PROJECT_TAG)}${after}`;
        };

        const listTheme = {
          label: colorizeLabel,
          value: (text: string, selected: boolean) => selected ? theme.fg('accent', text) : theme.fg('muted', text),
          description: (text: string) => {
            // SettingsList calls this once per wrapped description line, so we
            // can't inspect the line alone — we look up the currently selected
            // item (respecting the active search filter) and color the whole
            // description yellow when it describes a destructive action.
            const list = settingsList as unknown as {
              searchEnabled?: boolean;
              filteredItems?: SettingItem[];
              items?: SettingItem[];
              selectedIndex: number;
            };
            const displayItems = list.searchEnabled ? list.filteredItems : list.items;
            const selectedItem = displayItems?.[list.selectedIndex];
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
            // DESTRUCTIVE + DEFERRED: changing the model clears the knowledge store, so it is
            // NOT auto-saved on cycle like the other settings. Persist + clear happen in the
            // close handler, gated on an explicit ctx.ui.confirm — and an Esc/cancel close
            // reverts the change entirely (nothing was written here, so there is nothing to
            // roll back on disk).
            changed = false;
            } else if (id === 'EMBEDDING_DEVICE') {
            // TUI offers only GPU (= safe auto/probe-then-fallback) and CPU.
            // Raw forced 'webgpu' (no probe) stays reachable via env var only.
            config.EMBEDDING_DEVICE = newValue === 'CPU' ? 'cpu' : 'auto';
            scope = 'user';
            } else if (id === 'KNOWLEDGE_STORE_CACHE_TTL_DAYS') {
            config.KNOWLEDGE_STORE_CACHE_TTL_DAYS = parseInt(newValue, 10);
            scope = 'user';
            } else {
            changed = false;
            }

            if (changed) {
              try {
                // Persist ONLY the key that changed — for BOTH scopes. A local write scoped to
                // all keys would freeze the sibling local key per-directory; a user write scoped
                // to all keys would snapshot the entire resolved config (env overrides included)
                // into config.env, freezing values the user never chose.
                saveConfig(config, scope, cwd, [ENV_KEY_BY_SETTING_ID[id] ?? `PI_RESEARCH_${id}`]);
                resetConfig();
              } catch (e: unknown) {
                ctx.ui.notify(`Failed to save: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            }

            // If Knowledge Mode was just turned on, warm the store in the background so the first
            // search after enabling doesn't block on a cold init (native embed stack + init lock,
            // a few seconds). Fire-and-forget: getStore() drives initialize() to completion. The
            // search tool also awaits readiness, so this is a latency optimisation, not a
            // correctness dependency — the store works without it, just slower on the first query.
            if (id === 'KNOWLEDGE_STORE_MODE' && newValue !== 'none') {
              const kmContainer = tryGetServiceContainerFromCtx(ctx);
              void getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, kmContainer)
                .then((s) => s.getStore())
                .catch((e) => logger.debug('[research-config] knowledge-store warm-up failed:', e));
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
            } else if (id === 'ACTION_METRICS') {
              wrappedDone({ type: 'action', action: 'metrics' });
            } else if (id === 'ACTION_LOGS_CLEAR') {
              wrappedDone({ type: 'action', action: 'logs_clear' });
            } else if (id === 'ACTION_SKILL_INSTALL') {
              wrappedDone({ type: 'action', action: 'skill_install' });
            } else if (id === 'ACTION_SKILL_UNINSTALL') {
              wrappedDone({ type: 'action', action: 'skill_uninstall' });
            }

          },
          () => wrappedDone({ type: 'cancel' }),
          { enableSearch: true }
        );

        return {
          render: (width: number) => {
            if (width < 4) return [];
            const border = theme.fg('muted', '─'.repeat(width));
            // Drop the blank separator lines the SettingsList widget inserts (before the
            // description and before the hint) so the menu renders as one gap-free block.
            const listLines = settingsList.render(width).filter(line => visibleWidth(line) > 0);

            // Header with title and search hint
            const titleText = 'Research Configuration';
            const hintText = 'Type to search';
            const header = `${titleText} ${theme.fg('dim', `(${hintText})`)}`;

            // Footer: which directory the [project]-scoped settings apply to.
            // "[project]" is yellow (matching the per-row tag); the rest is dim.
            // Kept on a single line so the outer truncate clips it cleanly when
            // the terminal is narrow.
            const dirName = path.basename(cwd);
            // Two-space indent so the footer's "[project]" lines up with the list rows
            // and the "[project]" in the description (both use a 2-space left margin).
            const pathInfoLine = `  ${theme.fg('warning', '[project]')}${theme.fg('dim', ` directory: ${dirName}`)}`;

            // No blank line before the footer: keep it flush under the hint line.
            const lines = [border, header, border, ...listLines, pathInfoLine];
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
      // Rendered inline (default): the menu replaces the editor and takes
      // keyboard focus. While a research run is active, the live research panel
      // is removed from the screen for the duration of the menu (see
      // setInteractiveTuiActive → hideMasterWidget), so the inline menu gets the
      // full screen and leaves no ghost rows on close — without an overlay popup.
    )
.then(async (result: any) => {
      // 1. Handle Critical Config Changes (Model/Device)
      // We do this after the TUI closes to avoid race conditions and redundant clears
      let modelChangeConfirmed = false;
      if (config.EMBEDDING_MODEL !== initialConfig.EMBEDDING_MODEL) {
        // The model change was deliberately NOT auto-saved on cycle (see the change handler):
        // it clears the knowledge store, so it needs the same explicit confirm as the other
        // destructive actions — and an Esc/cancel close must abandon it without prompting.
        const cancelled = result?.type === 'cancel';
        modelChangeConfirmed = !cancelled && await ctx.ui.confirm(
          'Change Embedding Model',
          `Switch the embedding model to ${config.EMBEDDING_MODEL.split('/').pop()}? This permanently clears the current knowledge store.`,
        );
        if (modelChangeConfirmed) {
          logger.info(`[research-config] Embedding model changed from ${initialConfig.EMBEDDING_MODEL} to ${config.EMBEDDING_MODEL}. Clearing knowledge store.`);
          try {
            saveConfig(config, 'user', cwd, ['PI_RESEARCH_EMBEDDING_MODEL']);
            resetConfig();
          } catch (e: unknown) {
            modelChangeConfirmed = false;
            ctx.ui.notify(`Failed to save: ${e instanceof Error ? e.message : String(e)}`, 'error');
          }
        }
        if (modelChangeConfirmed) {
          try {
          const service = await getService<KnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
          await service.clear();
          await clearService(ServiceNames.KNOWLEDGE_STORE, container);
          const { clearEmbeddingInstance } = await import('./infrastructure/embedding/embedding-factory.ts');
          clearEmbeddingInstance();
          ctx.ui.notify('Model updated. Store cleared.', 'info');
          } catch (e: unknown) {
          logger.warn('[research-config] Failed to clear knowledge store on model change:', e);
          }
        } else {
          // Declined, cancelled, or the save failed: revert the in-memory value so nothing
          // downstream acts on a model that was never persisted.
          config.EMBEDDING_MODEL = initialConfig.EMBEDDING_MODEL;
          if (!cancelled) ctx.ui.notify('Embedding model unchanged.', 'info');
        }
      }
      if (!modelChangeConfirmed && config.EMBEDDING_DEVICE !== initialConfig.EMBEDDING_DEVICE) {
          logger.info('[research-config] Device changed. Resetting service.');
          try {
          await clearService(ServiceNames.KNOWLEDGE_STORE, container);
          const { clearEmbeddingInstance } = await import('./infrastructure/embedding/embedding-factory.ts');
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
          case 'metrics':
            await showMetricsAction(ctx, pi);
            if (await ctx.ui.confirm('Session Metrics', 'Reset all session counters?')) {
              metrics.clearSession();
              ctx.ui.notify('Session metrics reset.', 'info');
            }
            break;
          case 'logs_clear': {
            const confirmed = await ctx.ui.confirm('Clear Logs', 'Delete the main diagnostic log file and all archived rotation files?');
            if (confirmed) {
              logger.clear();
              ctx.ui.notify('Diagnostic logs cleared.', 'info');
            }
            break;
          }
          case 'skill_install':
            await installSkillAction(ctx, pi);
            break;
          case 'skill_uninstall':
            await uninstallSkillAction(ctx, pi);
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

/** id → human label for the coding agents the installer targets. */
const HARNESS_LABEL: Record<string, string> = Object.fromEntries(
  HARNESSES.map(h => [h.id, h.label]),
);

/**
 * Symlink the pi-research skill into each target coding agent (Claude, Codex)
 * whose ROOT config folder already exists. Agents without a config folder are
 * skipped — we never create an agent's home dir. An agent slot already occupied
 * by an unrelated skill is left untouched.
 */
async function installSkillAction(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  try {
    const presentById = new Map(skillInstallCandidates().map(d => [d.id, true] as const));
    const targets = SKILL_AGENT_TARGETS.filter(id => presentById.get(id));

    // resolveSkillSourceDir (inside installSkill) throws if the bundled SKILL.md
    // cannot be located — caught below and surfaced to the user.
    const results = targets.length ? installSkill([...targets]) : [];
    const resById = new Map(results.map(r => [r.tool, r]));

    const lines: string[] = ['## pi-research skill — install', ''];
    let ok = 0;
    for (const id of SKILL_AGENT_TARGETS) {
      const label = HARNESS_LABEL[id] ?? id;
      if (!presentById.get(id)) {
        lines.push(`- **${label}** — not detected on this machine; skipped.`);
        continue;
      }
      const r = resById.get(id);
      switch (r?.status) {
        case 'installed':
          ok++;
          lines.push(`- **${label}** — ${r.type === 'copy' ? 'copied (symlink unavailable)' : 'symlinked'} → \`${r.path}\``);
          break;
        case 'already-installed':
          ok++;
          lines.push(`- **${label}** — already installed → \`${r.path}\``);
          break;
        case 'skipped-foreign':
          lines.push(`- **${label}** — a different skill already occupies this slot; left untouched.`);
          break;
        case 'error':
          lines.push(`- **${label}** — failed: ${r.message ?? 'unknown error'}`);
          break;
        default:
          lines.push(`- **${label}** — ${r?.status ?? 'no result'}`);
      }
    }
    lines.push('', 'The skill activates automatically — just ask the agent to pi-research something.');

    pi.sendMessage({ customType: 'skill-install-result', content: lines.join('\n'), display: true });
    if (ctx.hasUI) {
      if (ok > 0) ctx.ui.notify(`Skill installed for ${ok} coding agent${ok === 1 ? '' : 's'}.`, 'info');
      else if (targets.length === 0) ctx.ui.notify('No coding agents detected (Claude, Codex).', 'warning');
      else ctx.ui.notify('No agents installed — see the message for details.', 'warning');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[research-config] Skill install failed: ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(`Skill install failed: ${msg}`, 'error');
  }
}

/**
 * Remove the pi-research skill symlinks this extension created from Claude and
 * Codex. Only installs we own are removed; foreign skills are kept.
 */
async function uninstallSkillAction(ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  // Deeper-level gate than install: only act on agents where the skill is
  // actually installed (an owned symlink/copy present on disk).
  const installedTargets = skillUninstallCandidates();
  if (installedTargets.length === 0) {
    if (ctx.hasUI) ctx.ui.notify('The skill is not installed in any coding agent.', 'info');
    return;
  }

  const names = installedTargets.map(d => HARNESS_LABEL[d.id] ?? d.id).join(' and ');
  const confirmed = await ctx.ui.confirm(
    'Uninstall Skill',
    `Remove the pi-research skill from ${names}? (Only symlinks this extension created are removed.)`,
  );
  if (!confirmed) return;
  try {
    const results = uninstallSkill(installedTargets.map(d => d.id));

    const lines: string[] = ['## pi-research skill — uninstall', ''];
    let removed = 0;
    if (results.length === 0) {
      lines.push('- Nothing to remove — the skill was not installed in any coding agent.');
    } else {
      for (const r of results) {
        const label = HARNESS_LABEL[r.tool] ?? r.tool;
        switch (r.status) {
          case 'removed':
            removed++;
            lines.push(`- **${label}** — removed → \`${r.path}\``);
            break;
          case 'not-present':
            lines.push(`- **${label}** — was not installed.`);
            break;
          case 'skipped-foreign':
            lines.push(`- **${label}** — not ours; left untouched.`);
            break;
          case 'error':
            lines.push(`- **${label}** — failed: ${r.message ?? 'unknown error'}`);
            break;
          default:
            lines.push(`- **${label}** — ${r.status}`);
        }
      }
    }

    pi.sendMessage({ customType: 'skill-uninstall-result', content: lines.join('\n'), display: true });
    if (ctx.hasUI) {
      ctx.ui.notify(removed > 0 ? `Skill removed from ${removed} coding agent${removed === 1 ? '' : 's'}.` : 'No installs were removed.', 'info');
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[research-config] Skill uninstall failed: ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(`Skill uninstall failed: ${msg}`, 'error');
  }
}

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
    const statusIcon = lastRun.status === 'success' ? '[ok]'
                     : lastRun.status === 'cancelled' ? '[cancelled]'
                     : '[failed]';
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
