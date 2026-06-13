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

import type { AgentSession, ModelRegistry, ExtensionContext } from '@earendil-works/pi-coding-agent';
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
  systemPrompt: string;
  extensionCtx: ExtensionContext;
  // Optional: real closures for global state management
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
  /** Optional researcher ID for per-researcher scrape tracking. */
  researcherId?: string;
  /** Callback invoked during search with cumulative link count found so far */
  onSearchProgress?: (links: number) => void;
  /** Fires for each individual URL scrape result (per-URL TUI flash). */
  onUrlScrapeResult?: (url: string, success: boolean) => void;
  /** List of tool names to disable for this researcher. */
  excludeTools?: string[];
  config?: Config;
}

export interface ResolvedResearcherSession {
  session: AgentSession;
  /** The model actually used for this session (after RESEARCH_MODEL resolution). */
  resolvedModel: Model<any>;
}

export async function createResearcherSession(options: CreateResearcherSessionOptions): Promise<ResolvedResearcherSession> {
  const {
    cwd,
    ctxModel,
    modelRegistry,
    systemPrompt,
    extensionCtx,
    getGlobalState,
    updateGlobalLinks,
    researcherId,
    onSearchProgress,
    onUrlScrapeResult,
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
  const tracker = new ToolUsageTracker(createDefaultToolLimits(config));

  // Use provided closures or fallback to safe dummies
  const globalLinks = updateGlobalLinks || (() => {});

  // Create a mutable reference to the session so the tools can access it
  // before the createAgentSession call returns.
  const sessionRef: { session: AgentSession | null } = { session: null };

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

  try {
    const customTools = createResearchTools({
      cwd,
      ctx: extensionCtx,
      tracker,
      getGlobalState,
      updateGlobalLinks: globalLinks,
      researcherId,
      onSearchProgress: onSearchProgress,
      onUrlScrapeResult: onUrlScrapeResult,
      getTokensUsed: () => {
        if (!sessionRef.session) return 0;
        
        // Prefer getContextUsage as it accounts for the full context window history
        if (typeof (sessionRef.session as any).getContextUsage === 'function') {
          const usage = (sessionRef.session as any).getContextUsage();
          if (usage && typeof usage.tokens === 'number') return usage.tokens;
        }
        
        // Fallback to cumulative session usage
        if (typeof (sessionRef.session as any).getUsage === 'function') {
          const usage = (sessionRef.session as any).getUsage();
          return (usage.input || 0) + (usage.output || 0);
        }
        
        return 0;
      },
      contextWindowSize: modelToUse.contextWindow,
      config,
    });

    // Explicit allowlist of custom tools minus dangerous built-ins.
    const defaultExclude = ['bash', 'write', 'edit', 'repl', 'git', 'terminal'];
    const mergedExclude = [...new Set([...defaultExclude, ...excludeTools])];

    const tools = customTools.map(t => t.name).filter(name => !mergedExclude.includes(name));

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
      thinkingLevel: 'minimal',
    });

    // Customize thinking label for researchers to distinguish them in the TUI
    if (extensionCtx.hasUI && typeof extensionCtx.ui.setHiddenThinkingLabel === 'function') {
      const internalId = systemPrompt.match(/ID: ([^)]+)/)?.[1] || 'Unknown';
      extensionCtx.ui.setHiddenThinkingLabel(`Researcher ${internalId}`);
    }

    // Log to confirm thinking level was set
    logger.log(`[Researcher] Created session with thinkingLevel='minimal', model=${modelToUse?.id || 'unknown'}`);

    if (!result || !result.session) {
      throw new Error('Session creation returned invalid result');
    }

    sessionRef.session = result.session;

    return { session: result.session, resolvedModel: modelToUse };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create researcher session: ${errorMsg}`, {
      cause: error,
    });
  }
}
