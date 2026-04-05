/**
 * Researcher Agents
 *
 * Creates researcher agent sessions.
 * Researchers use web search, scraping, security databases, and code search tools.
 */

import type { AgentSession, ModelRegistry, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createAgentSession, createReadTool, SessionManager } from '@mariozechner/pi-coding-agent';
import { createResearchTools } from '../tools/index.ts';
import { makeResourceLoader } from '../utils/make-resource-loader.ts';
import { ToolUsageTracker, createDefaultToolLimits } from '../utils/tool-usage-tracker.ts';

export interface CreateResearcherSessionOptions {
  cwd: string;
  ctxModel: any; // Model<any> | undefined
  modelRegistry: ModelRegistry;
  settingsManager: SettingsManager;
  systemPrompt: string;
  searxngUrl: string;
  extensionCtx: any; // ExtensionContext
}

export async function createResearcherSession(options: CreateResearcherSessionOptions): Promise<AgentSession> {
  const { cwd, ctxModel, modelRegistry, settingsManager, systemPrompt, searxngUrl, extensionCtx } = options;

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

  try {
    const result = await createAgentSession({
      cwd,
      tools: [createReadTool(cwd)],
      customTools: createResearchTools({ searxngUrl, ctx: extensionCtx, tracker }),
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
