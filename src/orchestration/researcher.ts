/**
 * Researcher Session Factory
 *
 * Responsible for instantiating individual researcher agent sessions. 
 * Each researcher is an autonomous agent equipped with a suite of specialized tools:
 * - Web search via SearXNG
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
  /** Returns tokens consumed by this researcher session so far (for context-aware scrape gating). */
  getTokensUsed?: () => number;
  /** Model context window size in tokens. */
  contextWindowSize?: number;
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
    getTokensUsed,
    contextWindowSize,
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
    const result = await createAgentSession({
      cwd,
      customTools: createResearchTools({
        ctx: extensionCtx,
        tracker,
        getGlobalState: globalState,
        updateGlobalLinks: globalLinks,
        onLinksScraped: onLinksScraped,
        getTokensUsed,
        contextWindowSize,
      }),
      sessionManager: SessionManager.inMemory(), // Each researcher gets its own isolated session
      settingsManager,
      model: ctxModel,
      modelRegistry,
      resourceLoader: makeResourceLoader(systemPrompt),
    });

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