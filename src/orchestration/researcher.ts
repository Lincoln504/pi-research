/**
 * Researcher Session Factory
 *
 * Responsible for instantiating individual researcher agent sessions. 
 * Each researcher is an autonomous agent equipped with a suite of specialized tools:
 * - Web search via DuckDuckGo Lite
 * - Context-aware URL scraping via Playwright
 * - Security vulnerability database queries (NVD, CISA, OSV)
 * - Technical Q&A retrieval from Stack Exchange
 * - Local code search via Ripgrep
 * - Knowledge store search for historical data
 */

import type { AgentSession, ModelRegistry, SettingsManager, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { createResearchTools } from '../tools/index.ts';
import { makeResourceLoader } from '../utils/make-resource-loader.ts';
import { ToolUsageTracker, createDefaultToolLimits } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import type { Config } from '../config.ts';
import { logger } from '../logger.ts';

export interface CreateResearcherSessionOptions {
  cwd: string;
  ctxModel: Model<any> | undefined;
  modelRegistry: ModelRegistry;
  settingsManager?: SettingsManager | undefined;
  systemPrompt: string;
  extensionCtx: ExtensionContext;
  // Optional: real closures for global state management
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  /** Callback invoked when links are scraped (for real-time coordination) */
  onLinksScraped?: (links: string[]) => void;
  /** Callback invoked during search with cumulative link count found so far */
  onSearchProgress?: (links: number) => void;
  /** List of tool names to disable for this researcher. */
  excludeTools?: string[];
  config?: Config;
}

export async function createResearcherSession(options: CreateResearcherSessionOptions): Promise<AgentSession> {
  const {
    cwd,
    ctxModel,
    modelRegistry,
    settingsManager,
    systemPrompt,
    extensionCtx,
    getGlobalState,
    updateGlobalLinks,
    onLinksScraped,
    onSearchProgress,
    excludeTools = [],
    config,
  } = options;

  // Validate required parameters
  if (!ctxModel) {
    throw new Error('No model selected. Please select a model before using the research tool.');
  }

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('Invalid system prompt: must be a non-empty string');
  }

  // Create tool usage tracker for this researcher
  const tracker = new ToolUsageTracker(createDefaultToolLimits());

  // Use provided closures or fallback to safe dummies
  const globalLinks = updateGlobalLinks || (() => {});

  try {
    const customTools = createResearchTools({
      cwd,
      ctx: extensionCtx,
      tracker,
      getGlobalState,
      updateGlobalLinks: globalLinks,
      onLinksScraped: onLinksScraped,
      onSearchProgress: onSearchProgress,
      config,
    });

    // Default "lockdown" list to prevent researchers from using built-in dangerous tools.
    // We use "excludeTools" instead of whitelisting to align with the new v0.77.0 mechanism.
    const defaultExclude = ['bash', 'write', 'edit', 'repl', 'git', 'terminal'];
    const mergedExclude = [...new Set([...defaultExclude, ...excludeTools])];

    const result = await createAgentSession({
      cwd,
      customTools,
      noTools: 'all', // Start with no tools enabled (built-in or otherwise)
      excludeTools: mergedExclude, // Exclude dangerous built-ins + user exclusions
      sessionManager: SessionManager.inMemory(), // Each researcher gets its own isolated session
      settingsManager,
      model: ctxModel,
      modelRegistry,
      resourceLoader: makeResourceLoader(systemPrompt),
      // Researchers do retrieval + synthesis from scraped pages — not deep reasoning.
      thinkingLevel: 'off',
    });

    // Customize thinking label for researchers to distinguish them in the TUI
    if (extensionCtx.ui?.setHiddenThinkingLabel && typeof extensionCtx.ui.setHiddenThinkingLabel === 'function') {
      const internalId = systemPrompt.match(/ID: ([^)]+)/)?.[1] || 'Unknown';
      extensionCtx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
    }

    // Log to confirm thinking level was set
    logger.log(`[Researcher] Created session with thinkingLevel='off', model=${ctxModel?.id || 'unknown'}`);

    if (!result || !result.session) {
      throw new Error('Session creation returned invalid result');
    }

    return result.session;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create researcher session: ${errorMsg}`, {
      cause: error,
    });
  }
}
