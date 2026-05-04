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
 */

import type { AgentSession, ModelRegistry, SettingsManager, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import { createResearchTools } from '../tools/index.ts';
import { makeResourceLoader } from '../utils/make-resource-loader.ts';
import { ToolUsageTracker, createDefaultToolLimits } from '../utils/tool-usage-tracker.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import type { Config } from '../config.ts';

export interface CreateResearcherSessionOptions {
  cwd: string;
  ctxModel: Model<any> | undefined;
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  systemPrompt: string;
  extensionCtx: ExtensionContext;
  // Optional: real closures for global state management
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  /** Callback invoked when links are scraped (for real-time coordination) */
  onLinksScraped?: (links: string[]) => void;
  /** Callback invoked during search with cumulative link count found so far */
  onSearchProgress?: (links: number) => void;
  /** If true, the researcher will not be given the search tool. */
  noSearch?: boolean;
  /** If true, the researcher will not be given the grep tool. Defaults to false. */
  noGrep?: boolean;
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
    noSearch,
    noGrep = false,
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
  const globalState = getGlobalState || (() => ({} as any));
  const globalLinks = updateGlobalLinks || (() => {});

  try {
    const allTools = createResearchTools({
      cwd,
      ctx: extensionCtx,
      tracker,
      getGlobalState: globalState,
      updateGlobalLinks: globalLinks,
      onLinksScraped: onLinksScraped,
      onSearchProgress: onSearchProgress,
      config,
    });

    // Exclude tools based on options
    let customTools = allTools;
    if (noSearch) {
        customTools = customTools.filter(t => t.name !== 'search');
    }
    if (noGrep) {
        customTools = customTools.filter(t => t.name !== 'grep');
    }

    // CRITICAL: Explicitly limit tools to ONLY what we provide.
    // This prevents the core AgentSession from injecting default tools like 'bash', 'write', 'edit', etc.
    const tools = customTools.map(t => t.name);

    const result = await createAgentSession({
      cwd,
      customTools,
      tools, // STRICT TOOL LOCKDOWN
      sessionManager: SessionManager.inMemory(), // Each researcher gets its own isolated session
      settingsManager,
      model: ctxModel,
      modelRegistry,
      resourceLoader: makeResourceLoader(systemPrompt),
      // Researchers do retrieval + synthesis from scraped pages — not deep reasoning.
      // Inheriting the user's default thinking level (often 'medium') causes every turn
      // to burn minutes on internal thinking, compounding to 15-25 min per researcher.
      thinkingLevel: 'off',
    });

    // Customize thinking label for researchers to distinguish them in the TUI
    if (extensionCtx.ui?.setHiddenThinkingLabel && typeof extensionCtx.ui.setHiddenThinkingLabel === 'function') {
      const internalId = systemPrompt.match(/ID: ([^)]+)/)?.[1] || 'Unknown';
      extensionCtx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
    }

    // Log to confirm thinking level was set
    const { logger: piLogger } = await import('../logger.ts');
    piLogger.log(`[Researcher] Created session with thinkingLevel='off', model=${ctxModel?.id || 'unknown'}`);

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
