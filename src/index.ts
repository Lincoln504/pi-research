import type { ExtensionAPI, ToolDefinition, AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ExtendedExtensionContext } from './types/extension-context.ts';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import type { ResearchResultDetails } from './types/index.ts';
import { createResearchTool, createHealthTool } from './tool.ts';
import { createResearchKnowledgeSearchTool } from './tools/research-knowledge-search.ts';
import { logger } from './logger.ts';
import { randomUUID } from 'node:crypto';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { getConfig, validateConfig } from './config.ts';
import { handleResearchConfigCommand } from './research-config.ts';
import { loadPrompt } from './utils/prompts.ts';
import { clearAllSessionState, addSteeringMessage, getSteeringMessages, normalizeSessionId, getActiveSessionCount, popQueuedMessages, getAllTrackedSessions, getPiActiveSessionOrder, getPiActivePanels } from './utils/session-state.ts';
import { initGlobalTuiController, disposeGlobalTuiController } from './tui/tui-controller.ts';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from './core/service-initialization.ts';
import { getServiceContainer } from './core/service-registry.ts';
import { registerInfrastructureServices } from './infrastructure/service-initialization.ts';

// Modular Orchestration Exports
export { ServiceNames } from './core/interfaces/service-names.ts';
export type { IResearchOrchestration, ResearchOptions } from './core/interfaces/orchestration-interfaces.ts';
export { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
export { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
export { shutdownManager } from './utils/shutdown-manager.ts';
export type { ResearchObserver } from './orchestration/research-observer.ts';
export { normalizeUrl } from './utils/shared-links.ts';
export { resetConfig, getConfig, setConfig, validateConfig } from './config.ts';

// Programmatic SDK Exports
export * from './sdk.ts';
export { HeadlessObserver, type HeadlessObserverOptions } from './orchestration/headless-observer.ts';

import {
  MAX_TEAM_SIZE_LEVEL_1,
  MAX_TEAM_SIZE_LEVEL_2,
  MAX_TEAM_SIZE_LEVEL_3,
} from './constants.ts';

// Extract the text content from a research tool result
function extractResultText(result: AgentToolResult<unknown>): string {
  const textBlock = result.content?.find(
    (c): c is { type: 'text'; text: string } => c.type === 'text',
  );
  return textBlock?.text || 'Research completed, but no text content was generated.';
}

/**
 * Pi Research Extension
 */
export default async function (pi: ExtensionAPI) {
  // Runtime version check — must match peerDependencies minimum (>=0.78.1)
  const versionParts = PI_VERSION.split('.').map(Number);
  const major = versionParts[0] ?? 0;
  const minor = versionParts[1] ?? 0;
  const patch = versionParts[2] ?? 0;
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
    throw new Error(
      `[pi-research] Cannot parse pi-coding-agent version "${PI_VERSION}". ` +
      `Please ensure pi-coding-agent is installed correctly.`,
    );
  }
  const minMajor = 0, minMinor = 78, minPatch = 1;
  const tooOld = major < minMajor
    || (major === minMajor && minor < minMinor)
    || (major === minMajor && minor === minMinor && patch < minPatch);
  if (tooOld) {
    throw new Error(
      `[pi-research] pi-coding-agent v${PI_VERSION} is too old. ` +
      `Requires v${minMajor}.${minMinor}.${minPatch}+. Please update pi-coding-agent.`,
    );
  }

  // 1. REGISTER CRITICAL EVENT LISTENERS IMMEDIATELY
  // This ensures we capture steering even if initialization takes time.
  pi.on('input', async (event: any, ctx: ExtensionContext) => {
    if (event.streamingBehavior === 'steer' && event.text) {
      try {
        const eCtx = ctx as ExtendedExtensionContext;
        // eslint-disable-next-line no-control-regex
        const sanitized = event.text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!sanitized) return undefined;

        const activeCount = getActiveSessionCount();
        if (activeCount === 0) return undefined;

        logger.debug(`[pi-research] Captured steering input. sessionId=${eCtx.sessionId}`);

        let sessionIds: string[] = [];
        if (eCtx.sessionId) {
          sessionIds = [eCtx.sessionId];
        } else {
          const activeSessions = getAllTrackedSessions().filter(sid => getPiActiveSessionOrder(sid).length > 0);
          if (activeSessions.length === 1) {
            sessionIds = [activeSessions[0]!];
          }
        }

        for (const sid of sessionIds) {
          // Check if any active research panel in this session can accept steering.
          // During eval/coordinator LLM calls, steering is popped to follow-up instead
          // of being queued, since the running LLM call cannot be interrupted and the
          // message might not be consumed before the research ends.
          const activePanels = getPiActivePanels(sid);
          const steeringAcceptable = activePanels.some(p => p.steeringAcceptable === true);

          if (steeringAcceptable) {
            addSteeringMessage(sid, sanitized);
          } else {
            // Steering not acceptable — immediately pop to pi's follow-up queue
            logger.debug(`[pi-research] Steering not acceptable for session ${sid}, popping to follow-up: ${sanitized}`);
            try {
              pi.sendUserMessage(sanitized, { deliverAs: 'followUp' });
            } catch (err) {
              logger.warn('[pi-research] Failed to send popped steering to follow-up:', err);
            }
          }
        }
        
        // Return handled to indicate we have fully processed this input 
        // and Pi should not echo it into the main chat log.
        return { action: 'handled' };
      } catch (err) {
        logger.debug('[pi-research] Input handler error:', err);
      }
    }
    
    return undefined;
  });

  // 2. REGISTER SHUTDOWN TASKS
  shutdownManager.register(async () => {
    try {
      clearAllSessionState();
      logger.info('[pi-research] All session state cleared');
      disposeGlobalTuiController();
      await disposeCoreServices();
      logger.log('[pi-research] All services disposed');
    } catch (err) {
      logger.error('[pi-research] Shutdown task failed:', err);
    }
  });

  // 3. SERVICE INITIALIZATION
  logger.log(`[pi-research] Activating extension (pi v${PI_VERSION})...`);

  // Register and initialize services into the global container
  try {
    const container = getServiceContainer();
    registerCoreServices(container);
    registerInfrastructureServices(container);
    logger.log('[pi-research] Services registered');
    
    // Pass pi as context — includes cwd for proper config loading
    const result = await initializeCoreServices(pi, container);
    if (result.failed.length > 0) {
      logger.error(`[pi-research] ⚠ Service initialization incomplete: ${result.failed.join(', ')}`);
    } else {
      logger.log('[pi-research] All critical services initialized and ready');
      container.isReady = true;
    }
  } catch (err) {
    logger.error('[pi-research] Critical failure during service setup:', err);
  }


  // Validate config at startup (using pi.cwd)
  try {
    const config = getConfig((pi as any).cwd);
    validateConfig(config);
    logger.debug('[pi-research] Config validated');
  } catch (err) {
    logger.error(`[pi-research] ⚠ Config validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Primary cleanup path for pi -p (print mode) and normal session end.
  pi.on('session_shutdown', async () => {
    try {
      await shutdownManager.runCleanup('session_shutdown');
    } catch (_err) {
      logger.error('[pi-research] session_shutdown cleanup failed:', _err);
    }
  });

  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool();
  pi.registerTool(researchTool);

  // Create and register the health check tool
  const healthTool: ToolDefinition = createHealthTool();
  pi.registerTool(healthTool);

  // Create and register the Research Knowledge Search tool
  const researchKnowledgeSearchTool: ToolDefinition | null =
    (getConfig((pi as any).cwd).LOCAL_KNOWLEDGE_STORE_ENABLED || getConfig((pi as any).cwd).GLOBAL_KNOWLEDGE_STORE_ENABLED)
      ? createResearchKnowledgeSearchTool()
      : null;
  if (researchKnowledgeSearchTool) {
    pi.registerTool(researchKnowledgeSearchTool);
  }

  // Alt+P — Pop queued steering messages back to pi's follow-up queue.
  pi.registerShortcut(Key.alt('p'), {
    description: 'Pop queued researcher steering messages back to chat',
    handler: (ctx: ExtensionContext) => {
      const eCtx = ctx as ExtendedExtensionContext;
      let piSessionId = eCtx.sessionId || eCtx.sessionManager?.getSessionId();

      if (!piSessionId) {
        const activeSessions = getAllTrackedSessions().filter(sid => getPiActiveSessionOrder(sid).length > 0);
        if (activeSessions.length === 1) {
          piSessionId = activeSessions[0]!;
        } else if (activeSessions.length > 1) {
          if (ctx.hasUI) ctx.ui.notify('Ambiguous sessions — cannot pop steering.', 'warning');
          return;
        } else {
          piSessionId = 'default';
        }
      }

      const activeCount = getActiveSessionCount();
      if (activeCount === 0) return;

      const queuedBefore = getSteeringMessages(piSessionId).filter(m => m.status === 'queued');
      const popped = popQueuedMessages(piSessionId);

      if (popped.length === 0) {
        if (ctx.hasUI && queuedBefore.length === 0) {
          ctx.ui.notify('No steering messages found.', 'info');
        }
        return;
      }
      for (const msg of popped) {
        pi.sendUserMessage(msg.text, { deliverAs: 'followUp' });
      }
      
      if (ctx.hasUI) {
        ctx.ui.notify(`Sent ${popped.length} steering message(s).`, 'info');
      }
    },
  });

  // /research <query> — direct quick research, no LLM turn.
  pi.registerCommand('research', {
    description: 'Web research a query',
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) return;

      try {
        const config = getConfig(ctx.cwd);
        
        const result = await researchTool.execute(
          randomUUID(),
          { query: text, depth: config.DEFAULT_RESEARCH_DEPTH },
          ctx.signal,
          undefined,
          ctx,
        );

        const output = extractResultText(result);

        pi.sendMessage({
          customType: 'research-result',
          content: output,
          display: true,
          details: { 
            totalTokens: (result.details as ResearchResultDetails)?.totalTokens ?? 0,
            researchId: (result.details as any)?.researchId
          },
        });

        if (ctx.hasUI) {
          ctx.ui.notify('Research finished.', 'info');
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[pi-research] /research command failed:', error);

        pi.sendMessage({
          customType: 'research-result',
          content: `**Research failed**\n\n${message}`,
          display: true,
          details: { error: message },
        });

        if (ctx.hasUI) {
          ctx.ui.notify(`Research failed: ${message}`, 'error');
        }
      }
    },
  });

  // /research-config — consolidated research configuration and management command
  pi.registerCommand('research-config', {
    description: 'Research configuration and management (health, errors, knowledge, settings, metrics)',
    handler: async (args, ctx: ExtensionContext) => {
      await handleResearchConfigCommand(args, ctx, pi);
    },
  });

  // JIT Prompt Injection (Simplified & Non-Intrusive)
  pi.on('before_agent_start', async (event: any, ctx: ExtensionContext) => {
    if (event.streamingBehavior === 'steer') {
      return { systemPrompt: event.systemPrompt };
    }

    if (ctx.mode === 'tui' && ctx.hasUI) {
      initGlobalTuiController(ctx.ui, (ctx as ExtendedExtensionContext).sessionId);
    }

    const eCtx = ctx as ExtendedExtensionContext;
    const normalizedSid = normalizeSessionId(eCtx.sessionId);
    const steeringMessages = getSteeringMessages(normalizedSid);
    let injectedSystemPrompt = event.systemPrompt;

    const activeCount = getActiveSessionCount();
    const hasSteeringMessages = steeringMessages.length > 0;
    const shouldInjectSteering = hasSteeringMessages && activeCount > 0;

    if (shouldInjectSteering) {
      injectedSystemPrompt += '\n\n### ADDITIONAL CONSIDERATIONS\n' + 
        'The user has provided the following additional considerations for this task:\n' + 
        steeringMessages.map(m => `- ${m.text}`).join('\n');
    }

    const isResearcher = event.systemPrompt?.includes('RESEARCHER_AGENT_MARKER');
    if (isResearcher) {
      return { systemPrompt: injectedSystemPrompt };
    }

    const isResearchToolAvailable = !event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchTool.name);
    const isKnowledgeSearchAvailable = researchKnowledgeSearchTool
      ? (!event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchKnowledgeSearchTool.name))
      : false;

    if (isResearchToolAvailable || isKnowledgeSearchAvailable) {
      let researchPrompt = loadPrompt('research-tool-usage')
        .replace('{{max_team_size_l1}}', MAX_TEAM_SIZE_LEVEL_1.toString())
        .replace('{{max_team_size_l2}}', MAX_TEAM_SIZE_LEVEL_2.toString())
        .replace('{{max_team_size_l3}}', MAX_TEAM_SIZE_LEVEL_3.toString());
      
      if (!isKnowledgeSearchAvailable) {
        researchPrompt = researchPrompt.replace(/\n\*\*⚡ KNOWLEDGE SEARCH\*\*[\s\S]*?---\n/m, '\n---\n');
      }
      
      return {
        systemPrompt: injectedSystemPrompt + '\n\n' + researchPrompt
      };
    }

    return { systemPrompt: injectedSystemPrompt };
  });

  // Monitor provider responses for diagnostics
  pi.on('after_provider_response', async (event: any, ctx: any) => {
    const { status, headers } = event;

    if (status >= 500) {
      logger.warn(`[pi-research] Provider server error: ${status}`, { headers });
    } else if (status === 429) {
      const retryAfter = headers?.['retry-after'];
      logger.warn(`[pi-research] Rate limited by provider`, { retryAfter });
      if (retryAfter && ctx.hasUI) {
        ctx.ui.notify(`Rate limited. Retry in ${retryAfter}s.`, 'warning');
      }
    } else if (status >= 400) {
      logger.warn(`[pi-research] Provider error: ${status}`, { headers });
    }
  });

  // Log health status at startup (non-blocking)
  setTimeout(async () => {
    try {
      const health = await healthRegistry.runAll();
      const statusIcon = health.status === 'healthy' ? '[OK]' :
                        health.status === 'degraded' ? '[WARN]' : '[ERROR]';
      const failedComponents = health.components.filter((c: any) => !c.healthy).map((c: any) => c.component).join(', ');

      if (health.status === 'healthy') {
        logger.log(`[pi-research] ${statusIcon} System health check passed. All components operational.`);
    } else {
        logger.warn(`[pi-research] ${statusIcon} System health check: ${health.status}. Failed: ${failedComponents || 'none'}`);
      }
    } catch (error) {
      logger.warn('[pi-research] Startup health check failed (non-fatal):', error);
    }
  }, 2000);

  logger.log('[pi-research] Extension loaded');
}
