// Set ONNX Runtime logging level early (before library load) to prevent 
// "Attempt to use DefaultLogger but none has been registered" crash on exit.
// Level 3 = Error, 4 = Fatal.
process.env['ORT_LOGGING_LEVEL'] = '3';

import type { ExtensionAPI, ToolDefinition, AgentToolResult, ExtensionContext, SessionShutdownEvent, SessionBeforeCompactEvent, SessionCompactEvent } from '@earendil-works/pi-coding-agent';
import type { ExtendedExtensionContext } from './types/extension-context.ts';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import type { ResearchResultDetails } from './types/index.ts';
import { createResearchTool, createHealthTool } from './tool.ts';
import { createResearchKnowledgeSearchTool } from './tools/research-knowledge-search.ts';
import { logger } from './logger.ts';
import { checkPiCompatibility } from './core/pi-version.ts';
import { randomUUID } from 'node:crypto';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { registerBeforeExitSafetyNet } from './knowledge/embedder-utils.ts';
import { getConfig, validateConfig } from './config.ts';
import { metrics } from './utils/metrics.ts';
import { handleResearchConfigCommand } from './research-config.ts';
import { loadPrompt } from './core/llm/prompts.ts';
import { clearAllSessionState, addSteeringMessage, getSteeringMessages, normalizeSessionId, getActiveSessionCount, popQueuedMessages, requeuePoppedMessage, getAllTrackedSessions, getPiActiveSessionOrder, getPiActivePanels } from './orchestration/session-state.ts';
import { initGlobalTuiController, disposeGlobalTuiController } from './tui/tui-controller.ts';
import { registerCoreServices, initializeCoreServices, disposeCoreServices } from './core/service-initialization.ts';
import { getServiceContainer, resetServiceContainer } from './core/service-registry.ts';
import { registerInfrastructureServices } from './infrastructure/service-initialization.ts';
import { registerOrchestrationServices } from './orchestration/service-initialization.ts';

// Modular Orchestration Exports
export { ServiceNames } from './core/interfaces/service-names.ts';
export type { IResearchOrchestration, ResearchOptions } from './core/interfaces/orchestration-interfaces.ts';
export { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
export { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
export { shutdownManager } from './utils/shutdown-manager.ts';
export type { ResearchObserver } from './core/interfaces/observer-interfaces.ts';
export { normalizeUrl } from './utils/shared-links.ts';
export { resetConfig, getConfig, setConfig, validateConfig } from './config.ts';

// Programmatic SDK Exports. Explicit list (not `export *`) so getSDKContainer —
// @internal, test-only in src/sdk.ts, imported only by shutdown-perf.test.ts via a
// direct relative path — is not re-published from the package's primary entry point.
// (It remains reachable via the separate, intentional `@lincoln504/pi-research/sdk`
// raw-module subpath in package.json exports, which this does not touch.)
export {
  initResearchSDK,
  type ResearchSDKOptions,
  repairJson,
  exportKnowledge,
  verifyUrl,
  scrapeUrl,
  runDeepResearch,
  getLastRunMetrics,
  getLastRunSummary,
  getLastErrorReport,
  getLastRunStats,
  getLastResearcherOutcome,
  type ResearcherOutcome,
  getSessionMetrics,
  getResearchHealth,
  runQuickResearch,
  getResearchReports,
  type ResearchRunResult,
  runResearchDetailed,
  type KnowledgeSearchResult,
  searchKnowledge,
  shutdownResearchSDK,
} from './sdk.ts';
export { HeadlessObserver, type HeadlessObserverOptions } from './orchestration/headless-observer.ts';

// Audit / metrics types for SDK consumers (getLastRunMetrics/getLastRunStats etc.)
export type { IMetricsSnapshot, IMetricHistogram, RunSummary } from './utils/metrics.ts';
export type { ResearchStats } from './utils/metrics-summary.ts';
export { extractRunStats } from './utils/metrics-summary.ts';

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
  // Runtime version check — must match the @earendil-works/* dependency minimum (>=0.84.0).
  // The floor is 0.84.0 because setRuntimeApiKey() lost its `allowNetwork` option there
  // and only 0.84.0+ hardcodes the equivalent guard internally (see pi-version.ts). The
  // APIs it rests on arrived in 0.80.8, which introduced ModelRuntime and removed
  // AuthStorage/ModelRegistry.create(); buildModelRegistry (model-registry-factory.ts)
  // unconditionally calls ModelRuntime.create(), and createAgentSession() is invoked
  // without the removed `modelRegistry` option (researcher.ts), relying on the
  // host auto-building its ModelRuntime. This in-host check is the real
  // enforcement point: when running as an extension the host's version is NOT
  // constrained by npm's resolution of our own package.json range.
  // Two thresholds, not one — see src/core/pi-version.ts. Below the floor the APIs
  // we call do not exist, so we refuse. Above the last TESTED line we warn and
  // continue: pi is pre-1.0, a minor bump can break anything under semver (0.83.0
  // already extended the ResourceLoader contract), and our own dependency range
  // cannot constrain the host at all when running as an extension.
  const compat = checkPiCompatibility(PI_VERSION);
  if (compat.fatal) {
    throw new Error(compat.message ?? `[pi-research] Unsupported pi-coding-agent version "${PI_VERSION}".`);
  }
  if (compat.message) {
    logger.warn(compat.message);
  }

  // Re-register the beforeExit safety net (deactivate() strips event listeners during reload).
  // This ensures the ONNX pipeline is disposed even after extension reloads.
  registerBeforeExitSafetyNet();

  // 1. REGISTER CRITICAL EVENT LISTENERS IMMEDIATELY
  // This ensures we capture steering even if initialization takes time.
  pi.on('input', async (event: any, ctx: ExtensionContext) => {
    // Only intercept genuine interactive keystrokes. Programmatic sends originate
    // from this extension (source 'extension') — e.g. the Alt+P pop handler forwards
    // a popped message as 'steer'. Without this guard that forward would be captured
    // straight back into the research queue, so the pop could never reach pi.
    if (event.source === 'extension') return undefined;
    if (event.streamingBehavior === 'steer' && event.text) {
      try {
        const eCtx = ctx as ExtendedExtensionContext;
        // eslint-disable-next-line no-control-regex
        const sanitized = event.text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!sanitized) return undefined;

        const activeCount = getActiveSessionCount();
        if (activeCount === 0) return undefined;

        logger.debug(`[pi-research] Captured steering input. sessionId=${eCtx.sessionId}`);

        // Best-effort UI feedback. Without it, a steering message that is forwarded to
        // pi's follow-up queue (because the current research step can't be interrupted)
        // is delivered but invisible — it looks like nothing happened.
        const notify = (msg: string, level: 'info' | 'warning' = 'info') => {
          try { if (ctx.hasUI) ctx.ui.notify(msg, level); } catch { /* notify is best-effort */ }
        };

        let sessionIds: string[] = [];
        if (eCtx.sessionId) {
          sessionIds = [eCtx.sessionId];
        } else {
          const activeSessions = getAllTrackedSessions().filter(sid => getPiActiveSessionOrder(sid).length > 0);
          if (activeSessions.length === 1) {
            sessionIds = [activeSessions[0]!];
          } else if (activeSessions.length > 1) {
            // Ambiguous — we cannot attribute the message to one research session.
            // Do NOT swallow it: fall through so pi applies its own native steering.
            notify('Multiple active research sessions — steering left to pi.', 'warning');
            return undefined;
          }
        }

        if (sessionIds.length === 0) {
          // No research session we can route to — let pi handle the input natively
          // rather than silently dropping it (returning 'handled' would eat it).
          return undefined;
        }

        let queued = 0;
        let forwarded = 0;
        for (const sid of sessionIds) {
          // Check if any active research panel in this session can accept steering.
          // During eval/coordinator LLM calls, steering is forwarded to follow-up
          // instead of being queued, since the running LLM call cannot be interrupted
          // and the message might not be consumed before the research ends.
          const activePanels = getPiActivePanels(sid);
          const steeringAcceptable = activePanels.some(p => p.steeringAcceptable === true);

          if (steeringAcceptable) {
            addSteeringMessage(sid, sanitized);
            queued++;
          } else {
            // Steering not acceptable right now (e.g. an eval/coordinator LLM call is in
            // flight). Forward to pi as a STEER, not a follow-up: steer is injected at the
            // next agent step — right after the running research tool returns its report —
            // so it lands as the next message instead of sitting until the agent stops
            // (which, in a long autonomous turn, may never happen). The source-'extension'
            // guard above prevents this from being re-captured back into the queue.
            logger.debug(`[pi-research] Steering not acceptable for session ${sid}, forwarding as steer: ${sanitized}`);
            try {
              await pi.sendUserMessage(sanitized, { deliverAs: 'steer' });
              forwarded++;
            } catch (err) {
              logger.warn('[pi-research] Failed to forward steering to pi:', err);
            }
          }
        }

        // Surface the outcome so the action is never invisible.
        if (queued > 0 && forwarded === 0) {
          notify('Queued — will steer the next research round.', 'info');
        } else if (forwarded > 0 && queued === 0) {
          notify('Sent to pi to steer the agent.', 'info');
        } else if (queued > 0 && forwarded > 0) {
          notify('Steering received (queued for next round + steer to pi).', 'info');
        } else {
          // Nothing was delivered (e.g. the steer send threw) — let pi handle it
          // natively rather than eating the message.
          return undefined;
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
      // Dispose native resources (ONNX pipeline) while C++ statics are still alive.
      await disposeCoreServices();
      logger.log('[pi-research] All services disposed');
      // Clear service REGISTRATIONS too (not just instances). disposeCoreServices
      // nulls instances but leaves the factory map intact, so without this a
      // same-process re-activate() (pi reload / new session) would re-run
      // registerCoreServices against an already-populated container and throw on
      // the first allowOverwrite:false register — leaving isReady=true over stale
      // services. Matches the SDK and CLI teardown (both reset after dispose).
      await resetServiceContainer(getServiceContainer());
      // Clear in-memory state after disposal.
      disposeGlobalTuiController();
      clearAllSessionState();
      metrics.clearSession();
      logger.info('[pi-research] All session state cleared');
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
    registerOrchestrationServices(container);
    logger.log('[pi-research] Services registered');
    
    // Pass pi as context — includes cwd for proper config loading
    const result = await initializeCoreServices(pi, container);
    if (result.failed.length > 0) {
      logger.error(`[pi-research] WARNING: Service initialization incomplete: ${result.failed.join(', ')}`);
    } else {
      logger.log('[pi-research] All critical services initialized and ready');
      container.isReady = true;
    }
  } catch (err) {
    logger.error('[pi-research] Critical failure during service setup:', err);
  }


  // Validate config at startup (using pi.cwd)
  try {
    const config = getConfig((pi as any).cwd, 'pi');
    validateConfig(config);
    logger.debug('[pi-research] Config validated');
  } catch (err) {
    logger.error(`[pi-research] WARNING: Config validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Self-heal cross-harness skill installs: re-point links left stale by an
  // update and prune ones left dangling by a prior removal. Best-effort — a
  // filesystem hiccup here must never block activation. (npm does not run our
  // preuninstall on uninstall, so this startup pass is the reliable GC.)
  try {
    const { reconcileSkillInstalls } = await import('./skill-install/skill-installer.ts');
    const r = reconcileSkillInstalls();
    if (r.repointed.length || r.pruned.length) {
      logger.info(`[pi-research] Skill links reconciled: ${r.repointed.length} re-pointed, ${r.pruned.length} pruned`);
    }
  } catch (err) {
    logger.debug('[pi-research] Skill reconcile skipped:', err);
  }

  // Primary cleanup path for pi -p (print mode) and normal session end.
  // Only arm force-exit and mark PI_PROCESS_EXITING on a genuine quit — not on
  // reload/new/resume/fork where the process continues under a rebuilt extension.
  pi.on('session_shutdown', async (event: SessionShutdownEvent) => {
    try {
      if (event.reason === 'quit') {
        process.env['PI_PROCESS_EXITING'] = '1';
        // Watchdog: browser pool + ONNX teardown can take up to ~30s in worst case.
        shutdownManager.forceExitAfter(35000);
      }
      await shutdownManager.runCleanup(`session_shutdown:${event.reason}`);
    } catch (_err) {
      logger.error('[pi-research] session_shutdown cleanup failed:', _err);
    }
  });

  pi.on('session_before_compact', (event: SessionBeforeCompactEvent) => {
    logger.debug(`[pi-research] compaction starting: reason=${event.reason} willRetry=${event.willRetry}`);
  });

  pi.on('session_compact', (event: SessionCompactEvent) => {
    logger.debug(`[pi-research] compaction complete: reason=${event.reason} willRetry=${event.willRetry}`);
  });

  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool('pi');
  pi.registerTool(researchTool);

  // Create and register the health check tool
  const healthTool: ToolDefinition = createHealthTool();
  pi.registerTool(healthTool);

  // Create and register the Research Knowledge Search tool. It is native-free at
  // construction (the vector/ML stack loads lazily on first execute) and self-guards when
  // Knowledge Mode is 'none' (its execute returns a "store disabled" miss). Registering it
  // unconditionally lets a Knowledge Mode change via /research-config take effect without a
  // Pi restart — availability to the agent and the /knowledge-store command below both key
  // off live config, not this startup binding. The pi API has no unregisterTool, so a
  // startup-gated registration could never be added back after enabling mid-session anyway.
  const researchKnowledgeSearchTool: ToolDefinition = createResearchKnowledgeSearchTool('pi');
  pi.registerTool(researchKnowledgeSearchTool);

  // Alt+P — Pop queued steering messages out of the research queue and steer pi with them.
  pi.registerShortcut(Key.alt('p'), {
    description: 'Pop queued research steering messages back to chat',
    handler: async (ctx: ExtensionContext) => {
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
        if (ctx.hasUI) {
          // queuedBefore>0 but nothing popped means the orchestrator consumed the
          // message between the panel render and this keypress — tell the user
          // rather than appearing to do nothing.
          ctx.ui.notify(
            queuedBefore.length === 0
              ? 'No steering messages found.'
              : 'Steering already consumed by research.',
            'info',
          );
        }
        return;
      }
      // Forward as 'steer', NOT 'followUp'. A popped message means "redirect the agent
      // now". A follow-up is only consumed once the agent would otherwise stop, so during
      // a long autonomous turn — e.g. a multi-round research the model keeps extending —
      // it never drains and the user sees their instruction ignored. 'steer' is injected
      // at the next agent step: right after the running research tool returns its report
      // into chat, the agent acts on it. (The input handler ignores source 'extension',
      // so this is not re-captured into the research queue.)
      let sent = 0;
      for (const msg of popped) {
        try {
          await pi.sendUserMessage(msg.text, { deliverAs: 'steer' });
          sent++;
        } catch (err) {
          // Never lose the user's words: restore the message to queued (still poppable).
          logger.warn('[pi-research] Failed to forward popped steering to pi:', err);
          requeuePoppedMessage(piSessionId, msg.id);
        }
      }

      if (ctx.hasUI) {
        if (sent > 0) {
          ctx.ui.notify(`Sent ${sent} steering message(s) to pi.`, 'info');
        } else {
          ctx.ui.notify('Could not send steering to pi — left it queued.', 'warning');
        }
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
        const config = getConfig(ctx.cwd, 'pi');
        
        const result = await researchTool.execute(
          randomUUID(),
          { query: text, depth: config.DEFAULT_RESEARCH_DEPTH },
          ctx.signal,
          undefined,
          ctx,
        );

        const output = extractResultText(result);

        try {
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
        } catch (deliverErr) {
          // ctx went stale (the session was closed mid-run) — there's no live session to
          // deliver the result to. Not a failure of the research itself.
          logger.debug('[pi-research] could not deliver research result (session closed):', deliverErr);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // A quit / session replacement mid-run aborts ctx.signal and invalidates ctx; the run
        // was cancelled, not broken, and any sendMessage/ui call below would itself throw
        // "ctx is stale after session replacement or reload". There is no live session to
        // report to, so exit quietly instead of logging a failure and re-throwing.
        if (ctx.signal?.aborted || /ctx is stale after session replacement/i.test(message)) {
          logger.debug('[pi-research] /research command ended early (session closed mid-run); skipping result delivery');
          return;
        }
        logger.error('[pi-research] /research command failed:', error);

        try {
          pi.sendMessage({
            customType: 'research-result',
            content: `**Research failed**\n\n${message}`,
            display: true,
            details: { error: message },
          });

          if (ctx.hasUI) {
            ctx.ui.notify(`Research failed: ${message}`, 'error');
          }
        } catch (deliverErr) {
          logger.debug('[pi-research] could not deliver failure notice (session closed):', deliverErr);
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

  // /knowledge-store <query> — search the local knowledge store for previously
  // researched findings (synthesised answer). Query-only: the store auto-manages its
  // own compaction/pruning after runs, so there is no manual maintenance subcommand.
  pi.registerCommand('knowledge-store', {
    description: 'Search the local research knowledge store for a query',
    handler: async (args, ctx: ExtensionContext) => {
      const text = args.trim();
      if (!text) return;

      // With KNOWLEDGE_STORE_MODE='none' the store is disabled and a search can only miss.
      // Point the user at the toggle instead. Read LIVE config so a /research-config change
      // applies without a Pi restart (getConfig is re-read after research-config's resetConfig).
      // Key the gate off the SAME cwd the tool below resolves its config from (ctx.cwd, not
      // the activation pi.cwd) so the "disabled?" check and the tool never disagree on the
      // mode when the session cwd differs from the activation directory.
      if (getConfig(ctx.cwd ?? (pi as any).cwd, 'pi').KNOWLEDGE_STORE_MODE === 'none') {
        const msg = 'The knowledge store is disabled (Knowledge Mode = none). Enable it via /research-config.';
        if (ctx.hasUI) ctx.ui.notify(msg, 'warning');
        else pi.sendMessage({ customType: 'knowledge-store', content: msg, display: true });
        return;
      }

      try {
        const result = await researchKnowledgeSearchTool.execute(
          randomUUID(),
          { queries: [text] },
          ctx.signal,
          undefined,
          ctx,
        );

        const output = extractResultText(result);
        try {
          pi.sendMessage({
            customType: 'knowledge-store',
            content: output,
            display: true,
            details: { researchId: (result.details as any)?.researchId },
          });
          if (ctx.hasUI) ctx.ui.notify('Knowledge search finished.', 'info');
        } catch (deliverErr) {
          logger.debug('[pi-research] could not deliver knowledge-store result (session closed):', deliverErr);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        // A quit/session replacement mid-run aborts ctx.signal and invalidates ctx —
        // the search was cancelled, not broken. Exit quietly (mirrors /research).
        if (ctx.signal?.aborted || /ctx is stale after session replacement/i.test(message)) {
          logger.debug('[pi-research] /knowledge-store command ended early (session closed mid-run)');
          return;
        }
        logger.error('[pi-research] /knowledge-store command failed:', error);
        try {
          pi.sendMessage({
            customType: 'knowledge-store',
            content: `**Knowledge store search failed**\n\n${message}`,
            display: true,
            details: { error: message },
          });
          if (ctx.hasUI) ctx.ui.notify(`Knowledge store search failed: ${message}`, 'error');
        } catch (deliverErr) {
          logger.debug('[pi-research] could not deliver knowledge-store failure notice (session closed):', deliverErr);
        }
      }
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

    // Researcher sub-agent sessions already carry the authoritative steering copy:
    // the executor (deep) and quick orchestrator inject "ADDITIONAL USER GUIDANCE"/
    // "ADDITIONAL CONSIDERATIONS" into the researcher's initial user message themselves
    // (kept OUT of the system prompt so its cacheable prefix stays byte-identical
    // across researchers — see researcher-executor.ts).
    // Appending the same messages again here delivered every steering message
    // TWICE to every researcher — return the prompt untouched. (The coordinator and
    // the research lead never pass through this hook at all: they run via
    // completeSimple, not an agent session, and get steering from planning-service
    // directly.)
    const isResearcher = event.systemPrompt?.includes('RESEARCHER_AGENT_MARKER');
    if (isResearcher) {
      return { systemPrompt: event.systemPrompt };
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

    const isResearchToolAvailable = !event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchTool.name);
    // Gate the KNOWLEDGE SEARCH prompt block on LIVE Knowledge Mode (not the startup tool
    // binding, which is now always registered) so enabling/disabling via /research-config
    // applies without a Pi restart. The tool must also be selected for this turn.
    // Key the gate off the SAME cwd the tool and /knowledge-store command resolve config
    // from (ctx.cwd, not the activation pi.cwd) — KNOWLEDGE_STORE_MODE is per-directory, so
    // when the session cwd differs from the activation dir the prompt block and the tool
    // must not disagree on whether the store is enabled.
    const knowledgeModeEnabled = getConfig(ctx.cwd ?? (pi as any).cwd, 'pi').KNOWLEDGE_STORE_MODE !== 'none';
    const isKnowledgeSearchAvailable = knowledgeModeEnabled &&
      (!event.systemPromptOptions || event.systemPromptOptions.selectedTools?.includes(researchKnowledgeSearchTool.name));

    if (isResearchToolAvailable || isKnowledgeSearchAvailable) {
      let researchPrompt = loadPrompt('research-tool-usage')
        .replace('{{max_team_size_l1}}', MAX_TEAM_SIZE_LEVEL_1.toString())
        .replace('{{max_team_size_l2}}', MAX_TEAM_SIZE_LEVEL_2.toString())
        .replace('{{max_team_size_l3}}', MAX_TEAM_SIZE_LEVEL_3.toString());
      
      if (!isKnowledgeSearchAvailable) {
        // Strip the whole KNOWLEDGE SEARCH block when no store is enabled. Match from
        // the `**KNOWLEDGE SEARCH` header (the title may carry a suffix, e.g.
        // "— MANDATORY FIRST STEP") through its terminating `---` rule.
        researchPrompt = researchPrompt.replace(/\n\*\*KNOWLEDGE SEARCH[\s\S]*?\n---\n/m, '\n---\n');
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

  // Log health status at startup (non-blocking). Track + unref the handle: unref() so a
  // short `pi -p` run isn't held open up to 2s waiting on it, and clear it on shutdown so a
  // fast reload/deactivate doesn't leave it pending to fire against disposed services.
  const healthTimer = setTimeout(async () => {
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
  if (healthTimer.unref) healthTimer.unref();
  shutdownManager.register(async () => clearTimeout(healthTimer));

  logger.log('[pi-research] Extension loaded');
}

/**
 * Extension Deactivation
 */
export async function deactivate(): Promise<void> {
  await shutdownManager.runCleanup('extension-deactivate');
}
