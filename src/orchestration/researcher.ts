/**
 * Researcher Agents
 *
 * Creates researcher agent sessions.
 * Researchers use web search, scraping, security databases, and code search tools.
 */

import type { AgentSession, ModelRegistry, SettingsManager, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createAgentSession, createReadTool, SessionManager } from '@mariozechner/pi-coding-agent';
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
  searxngUrl: string;
  extensionCtx: ExtensionContext;
  // Optional: real closures for global state management
  getGlobalState?: () => SystemResearchState;
  updateGlobalLinks?: (links: string[]) => void;
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
    searxngUrl,
    extensionCtx,
    getGlobalState,
    updateGlobalLinks,
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

  if (!searxngUrl || typeof searxngUrl !== 'string') {
    throw new Error('Invalid SearXNG URL: must be a non-empty string');
  }

  // Create tool usage tracker for this researcher
  const tracker = new ToolUsageTracker(createDefaultToolLimits());

  // Use provided closures or fallback to safe dummies
  const globalState = getGlobalState || (() => ({} as any));
  const globalLinks = updateGlobalLinks || (() => {});

  try {
    const result = await createAgentSession({
      cwd,
      tools: [createReadTool(cwd)],
      customTools: createResearchTools({
        searxngUrl,
        ctx: extensionCtx,
        tracker,
        getGlobalState: globalState,
        updateGlobalLinks: globalLinks,
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