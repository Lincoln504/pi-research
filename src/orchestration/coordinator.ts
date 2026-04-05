/**
 * Coordinator Agent
 *
 * Creates the coordinator agent session.
 * The coordinator naturally calls delegate_research and investigate_context tools.
 */

import type { AgentSession, ModelRegistry, SessionManager, SettingsManager, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { createAgentSession, createReadTool } from '@mariozechner/pi-coding-agent';
import { makeResourceLoader } from '../utils/make-resource-loader.ts';

export interface CreateCoordinatorSessionOptions {
  cwd: string;
  ctxModel: any; // Model<any> | undefined
  modelRegistry: ModelRegistry;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  systemPrompt: string;
  customTools?: ToolDefinition[];
}

export async function createCoordinatorSession(options: CreateCoordinatorSessionOptions): Promise<AgentSession> {
  const { cwd, ctxModel, modelRegistry, sessionManager, settingsManager, systemPrompt, customTools = [] } = options;

  if (!ctxModel) {
    throw new Error('No model selected. Please select a model before using the research tool.');
  }

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    throw new Error('Invalid system prompt: must be a non-empty string');
  }

  try {
    const result = await createAgentSession({
      cwd,
      tools: [createReadTool(cwd)],
      customTools,
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
    throw new Error(`Failed to create coordinator session: ${errorMsg}`, {
      cause: error,
    });
  }
}
