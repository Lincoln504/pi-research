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
import { clearAllSessionState, addSteeringMessage, getSteeringMessages, normalizeSessionId, getActiveSessionCount, popQueuedMessages, getAllTrackedSessions, getPiActiveSessionOrder } from './utils/session-state.ts';
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
  // The SDK uses 'streamingBehavior === "steer"' to identify mid-run guidance.
  // We capture these messages specifically for the active research run and 
  // suppress the SDK's built-in steering UI to maintain TUI consistency.
  pi.on('input', async (event: any, ctx: ExtensionContext) => {
    // PASSIVE: We only capture steering messages. 
    // We NEVER swallow input (action: "handled") because it interferes with user experience.
    if (event.streamingBehavior === 'steer' && event.text) {
      try {
        const eCtx = ctx as ExtendedExtensionContext;
        // eslint-disable-next-line no-control-regex
        const sanitized = event.text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!sanitized) return undefined;
      
        // Only route steering if research is actually active
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
          } else if (activeSessions.length > 1) {
            logger.warn(`[pi-research] ctx.sessionId missing and multiple active sessions exist — cannot route steering safely.`);
          }
        }

        for (const sid of sessionIds) {
          addSteeringMessage(sid, sanitized);
        }
      } catch (err) {
        logger.debug('[pi-research] Input handler error:', err);
      }
    }
    
    return undefined; // Always let the host handle the input
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

  // Register and initialize services
  try {
    registerCoreServices();
    registerInfrastructureServices();
    logger.log('[pi-research] Services registered');
    
    const container = getServiceContainer();
    const result = await initializeCoreServices(pi);
    if (result.failed.length > 0) {
      logger.error(`[pi-research] ⚠ Service initialization incomplete: ${result.failed.join(', ')}`);
    } else {
      logger.log('[pi-research] All critical services initialized and ready');
      container.isReady = true;
    }
  } catch (err) {
    logger.error('[pi-research] Critical failure during service setup:', err);
  }


  // Validate config at startup
  try {
    const config = getConfig();
    validateConfig(config);
    logger.debug('[pi-research] Config validated');
  } catch (err) {
    logger.error(`[pi-research] ⚠ Config validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Primary cleanup path for pi -p (print mode) and normal session end.
  // Pi fires session_shutdown from disposeRuntime() before process.exit() so this
  // reliably drains the writer queue and disposes the embedder even in non-signal exits.
  pi.on('session_shutdown', async () => {
    try {
      await shutdownManager.runCleanup('session_shutdown');
    } catch (_err) {
      logger.error('[pi-research] session_shutdown cleanup failed:', _err);
    }
  });

  // Global extension state for smart dual-sided prompt injection
  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool();
  pi.registerTool(researchTool);

  // Create and register the health check tool
  const healthTool: ToolDefinition = createHealthTool();
  pi.registerTool(healthTool);

  // Create and register the Research Knowledge Search tool (local research knowledge database search).
  // This is a top-level satellite tool for the main pi agent — NOT for researcher sub-agents.
  // Only registered when knowledge store is enabled (project scope, shared scope, or both).
  // The ExtensionContext is provided by pi at execution time inside the execute() closure.
  const researchKnowledgeSearchTool: ToolDefinition | null =
    (getConfig().LOCAL_KNOWLEDGE_STORE_ENABLED || getConfig().GLOBAL_KNOWLEDGE_STORE_ENABLED)
      ? createResearchKnowledgeSearchTool()
      : null;
  if (researchKnowledgeSearchTool) {
    pi.registerTool(researchKnowledgeSearchTool);
  }

  // Alt+P — Pop queued steering messages back to pi's follow-up queue.
  // The shortcut handler receives an ExtensionContext (not ExtensionAPI),
  // but `pi` is captured in the closure and remains valid for the
  // extension's lifetime. This is safe because extension reloads recreate
  // the module and thus refresh the closure.
  pi.registerShortcut(Key.alt('p'), {
    description: 'Pop queued researcher steering messages back to chat',
    handler: (ctx: ExtensionContext) => {
      const eCtx = ctx as ExtendedExtensionContext;

      // Improved session ID resolution: try explicit ID first, then fallback to active session
      let piSessionId = eCtx.sessionId || eCtx.sessionManager?.getSessionId();

      if (!piSessionId) {
        const activeSessions = getAllTrackedSessions().filter(sid => getPiActiveSessionOrder(sid).length > 0);
        if (activeSessions.length === 1) {
          piSessionId = activeSessions[0]!;
          logger.debug(`[pi-research] Alt+P: ctx.sessionId missing, falling back to only active session: ${piSessionId}`);
        } else if (activeSessions.length > 1) {
          logger.warn(`[pi-research] Alt+P: ctx.sessionId missing and multiple active sessions exist — cannot pop safely.`);
          if (ctx.hasUI) ctx.ui.notify('Multiple active sessions — cannot pop steering unambiguously', 'warning');
          return;
        } else {
          piSessionId = 'default';
        }
      }

      // Only pop if there are queued messages and research is active
      const activeCount = getActiveSessionCount();
      if (activeCount === 0) {
        logger.debug(`[pi-research] Alt+P pressed but no active research (sessionId=${piSessionId}) — ignoring`);
        return;
      }

      const queuedBefore = getSteeringMessages(piSessionId).filter(m => m.status === 'queued');
      const popped = popQueuedMessages(piSessionId);

      logger.debug(`[pi-research] Alt+P: sessionId=${piSessionId}, queuedCount=${queuedBefore.length}, poppedCount=${popped.length}`);

      if (popped.length === 0) {
        logger.debug(`[pi-research] Alt+P: no messages popped. queuedBefore=${queuedBefore.length}`);
        if (ctx.hasUI && queuedBefore.length === 0) {
          ctx.ui.notify('No queued steering messages to pop', 'info');
        }
        return;
      }
      // Forward each popped message to pi's follow-up queue
      for (const msg of popped) {
        logger.info(`[pi-research] Popping steering message: ${msg.text}`);
        pi.sendUserMessage(msg.text, { deliverAs: 'followUp' });
      }
      
      if (ctx.hasUI) {
        ctx.ui.notify(`Popped ${popped.length} steering message(s) to chat`, 'info');
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
        const config = getConfig();
        
        // Directly invoke the research tool, bypassing the LLM entirely.
        // The tool handles its own TUI panel, progress tracking, and cleanup.
        const result = await researchTool.execute(
          randomUUID(),
          { query: text, depth: config.DEFAULT_RESEARCH_DEPTH },
          ctx.signal,
          undefined,
          ctx,
        );

        const output = extractResultText(result);

        // Inject result as a custom message — no agent turn triggered.
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
          ctx.ui.notify('Research complete', 'info');
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
    
    // Skip injection during mid-stream steering
    if (event.streamingBehavior === 'steer') {
      return { systemPrompt: event.systemPrompt };
    }

    // Only initialize TUI features in TUI mode
    if (ctx.mode === 'tui' && ctx.hasUI) {
      initGlobalTuiController(ctx.ui, (ctx as ExtendedExtensionContext).sessionId);
    }

    // Framing steering as "Additional considerations"
    const eCtx = ctx as ExtendedExtensionContext;
    const normalizedSid = normalizeSessionId(eCtx.sessionId);
    const steeringMessages = getSteeringMessages(normalizedSid);
    let injectedSystemPrompt = event.systemPrompt;

    // Only inject steering messages when research is actually active.
    const activeCount = getActiveSessionCount();
    const hasSteeringMessages = steeringMessages.length > 0;
    const shouldInjectSteering = hasSteeringMessages && activeCount > 0;

    if (shouldInjectSteering) {
      injectedSystemPrompt += '\n\n### ADDITIONAL CONSIDERATIONS\n' + 
        'The user has provided the following additional considerations for this task:\n' + 
        steeringMessages.map(m => `- ${m.text}`).join('\n');
      logger.debug(`[pi-research] Injected ${steeringMessages.length} steering message(s) into prompt`);
    }

    // Do not inject rules into the sub-researchers
    const isResearcher = event.systemPrompt?.includes('RESEARCHER_AGENT_MARKER');
    if (isResearcher) {
      return { systemPrompt: event.systemPrompt };
    }

    // Conservative Prompt Injection: Only inject research instructions if the tool is 
    // actually selected/available for this turn.
    const isResearchToolAvailable = !event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchTool.name);
    const isKnowledgeSearchAvailable = researchKnowledgeSearchTool
      ? (!event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchKnowledgeSearchTool.name))
      : false;

    if (isResearchToolAvailable || isKnowledgeSearchAvailable) {
      logger.debug('[pi-research] Research-related tool available, injecting best-practice instructions.');
      
      const researchPrompt = loadPrompt('research-tool-usage')
        .replace('{MAX_TEAM_SIZE_L1}', MAX_TEAM_SIZE_LEVEL_1.toString())
        .replace('{MAX_TEAM_SIZE_L2}', MAX_TEAM_SIZE_LEVEL_2.toString())
        .replace('{MAX_TEAM_SIZE_L3}', MAX_TEAM_SIZE_LEVEL_3.toString());
      
      return {
        systemPrompt: injectedSystemPrompt + '\n\n' + researchPrompt
      };
    }

    return { systemPrompt: injectedSystemPrompt };
  });

  // Monitor provider responses for diagnostics
  pi.on('after_provider_response', async (event: any, ctx: any) => {
    const { status, headers } = event;

    // Log provider status for diagnostics
    if (status >= 500) {
      logger.warn(`[pi-research] Provider server error: ${status}`, { headers });
    } else if (status === 429) {
      const retryAfter = headers?.['retry-after'];
      logger.warn(`[pi-research] Rate limited by provider`, { retryAfter });
      if (retryAfter && ctx.hasUI) {
        ctx.ui.notify(`Rate limited. Retry after ${retryAfter}s`, 'warning');
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
