/**
 * Researcher Agents
 *
 * Creates researcher agent sessions.
 * Researchers use web search, scraping, security databases, and code search tools.
 */

import type { AgentSession, ModelRegistry, SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createAgentSession, createReadTool } from '@mariozechner/pi-coding-agent';
import { createAgentTools } from '../agent-tools.ts';
import { makeResourceLoader } from '../make-resource-loader.ts';

export interface CreateResearcherSessionOptions {
  cwd: string;
  ctxModel: any; // Model<any> | undefined
  modelRegistry: ModelRegistry;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  systemPrompt: string;
  searxngUrl: string;
  extensionCtx: any; // ExtensionContext
}

export async function createResearcherSession(options: CreateResearcherSessionOptions): Promise<AgentSession> {
  const { cwd, ctxModel, modelRegistry, sessionManager, settingsManager, systemPrompt, searxngUrl, extensionCtx } = options;

  if (!ctxModel) {
    throw new Error('No model selected. Please select a model before using the research tool.');
  }

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('Invalid system prompt: must be a non-empty string');
  }

  if (!searxngUrl || typeof searxngUrl !== 'string') {
    throw new Error('Invalid SearXNG URL: must be a non-empty string');
  }

  try {
    const result = await createAgentSession({
      cwd,
      tools: [createReadTool(cwd)],
      customTools: createAgentTools({ searxngUrl, ctx: extensionCtx }),
      sessionManager,
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
