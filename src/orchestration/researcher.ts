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

  const { session } = await createAgentSession({
    cwd,
    tools: [createReadTool(cwd)],
    customTools: createAgentTools({ searxngUrl, ctx: extensionCtx }),
    sessionManager,
    settingsManager,
    model: ctxModel,
    modelRegistry,
    resourceLoader: makeResourceLoader(systemPrompt),
  });

  return session;
}
