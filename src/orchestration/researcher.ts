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
import { createAgentSession, SessionManager, SettingsManager as SettingsManagerClass } from '@earendil-works/pi-coding-agent';
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

    // Explicit allowlist of custom tools minus dangerous built-ins.
    const defaultExclude = ['bash', 'write', 'edit', 'repl', 'git', 'terminal'];
    const mergedExclude = [...new Set([...defaultExclude, ...excludeTools])];

    const tools = customTools.map(t => t.name).filter(name => !mergedExclude.includes(name));

    // Prefer config.RESEARCH_MODEL for researcher sub-agents if provided.
    let modelToUse = ctxModel;
    if (config?.RESEARCH_MODEL) {
      const target = config.RESEARCH_MODEL;
      const found = modelRegistry.getAll().find(
        m => `${m.provider}/${m.id}` === target || m.id === target
      );
      if (found) {
        modelToUse = found;
        logger.info(`[Researcher] Using RESEARCH_MODEL override: ${target}`);
      } else {
        logger.warn(`[Researcher] RESEARCH_MODEL '${target}' not found in registry; falling back to default.`);
      }
    }

    // Build a researcher-scoped settings manager with provider retries restored to 2.
    // v0.76.0 changed the SDK default to 0; transient network errors during long researcher
    // runs would otherwise fail the entire researcher rather than retrying the LLM call.
    const researcherSettings = SettingsManagerClass.inMemory({ retry: { provider: { maxRetries: 2 } } });

    const result = await createAgentSession({
      cwd,
      customTools,
      tools, // Explicit allowlist (BUG-1 fix)
      sessionManager: SessionManager.inMemory(), // Each researcher gets its own isolated session
      settingsManager: researcherSettings,
      model: modelToUse,
      modelRegistry,
      resourceLoader: makeResourceLoader(systemPrompt),
      // Researchers do retrieval + synthesis from scraped pages — not deep reasoning.
      thinkingLevel: 'off',
    });

    // Customize thinking label for researchers to distinguish them in the TUI
    if (extensionCtx.hasUI && typeof extensionCtx.ui.setHiddenThinkingLabel === 'function') {
      const internalId = systemPrompt.match(/ID: ([^)]+)/)?.[1] || 'Unknown';
      extensionCtx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
    }

    // Log to confirm thinking level was set
    logger.log(`[Researcher] Created session with thinkingLevel='off', model=${modelToUse?.id || 'unknown'}`);

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
