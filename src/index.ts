import type { ExtensionAPI, ToolDefinition, AgentToolResult } from '@mariozechner/pi-coding-agent';
import type { NodeError, ResearchResultDetails } from './types/index.ts';
import { createResearchTool, createHealthTool } from './tool.ts';
import { logger } from './logger.ts';
import { randomUUID } from 'node:crypto';
import { shutdownManager } from './utils/shutdown-manager.ts';
import { shutdownKnowledgeStore } from './knowledge/index.ts';
import { healthRegistry } from './healthcheck/index.ts';
import { handleResearchConfigCommand } from './research-config.ts';
import { loadPrompt } from './utils/prompts.ts';
import { clearAllSessionState } from './utils/session-state.ts';
import { stopBrowserManager, getClientAgent } from './infrastructure/browser-manager.ts';
import { resetTerminalState } from './utils/terminal-state.ts';

// Modular Orchestration Exports
export { runResearch, type ResearchOptions } from './orchestration/research-manager.ts';
export { DeepResearchOrchestrator, type DeepResearchOrchestratorOptions } from './orchestration/deep-research-orchestrator.ts';
export { QuickResearchOrchestrator, type QuickResearchOrchestratorOptions } from './orchestration/quick-research-orchestrator.ts';
export { shutdownManager } from './utils/shutdown-manager.ts';
export type { ResearchObserver } from './orchestration/research-observer.ts';
export { normalizeUrl } from './utils/shared-links.ts';
export { resetConfig, getConfig, setConfig } from './config.ts';

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
export default function (pi: ExtensionAPI) {
  logger.log('[pi-research] Activating extension...');

  // Global uncaught exception handler to catch synchronous errors that escape all promise handlers.
  // This is a last-resort guard for things like undici's EventEmitter-based socket close errors.
  let uncaughtExceptionCount = 0;
  const MAX_UNCAUGHT_EXCEPTIONS = 3;

  shutdownManager.registerEventListener(process, 'uncaughtException', (err: Error, origin: string) => {
    // EPIPE = pi closed its stdout/stderr pipe before we finished writing (normal at shutdown).
    // Check before incrementing so it never contributes to the crash threshold.
    const nodeErr = err as NodeError;
    if (err.message.includes('EPIPE') || nodeErr.code === 'EPIPE') {
      logger.warn('[pi-research] EPIPE — pipe closed (normal at shutdown), ignoring.');
      return;
    }

    uncaughtExceptionCount++;
    const errorMsg = `[pi-research] Uncaught exception #${uncaughtExceptionCount}/${MAX_UNCAUGHT_EXCEPTIONS}: ${err.message}`;
    const errorOrigin = `[origin: ${origin}]`;

    logger.error(`${errorMsg} ${errorOrigin}`, err);

    // Log stack trace for debugging
    if (err.stack) {
      logger.error(`[pi-research] Stack trace:\n${err.stack}`);
    }

    // If we've hit too many uncaught exceptions, let the process exit to prevent infinite loops
    if (uncaughtExceptionCount >= MAX_UNCAUGHT_EXCEPTIONS) {
      logger.error('[pi-research] Too many uncaught exceptions. Exiting process to prevent infinite loop.');
      process.exit(1);
    }

    // For common recoverable errors (like undici socket timeouts), don't crash the process.
    // These can happen during network operations and are handled at a higher level via retries.
    const isNetworkError =
      err.message.includes('ETIMEDOUT') ||
      err.message.includes('ECONNRESET') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ENOTFOUND') ||
      err.message.includes('terminated') ||
      err.message.includes('socket');

    if (isNetworkError) {
      logger.warn('[pi-research] Network error caught by uncaught exception handler. Continuing...');
      return; // Don't crash on network errors
    }

    // For unknown error types, log a warning but continue
    logger.warn('[pi-research] Continuing after uncaught exception. Application state may be corrupted.');
  });

  // Also handle unhandled promise rejections
  shutdownManager.registerEventListener(process, 'unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('[pi-research] Unhandled promise rejection:', error.message, error);
    
    // Log stack trace if available
    if (error.stack) {
      logger.error(`[pi-research] Rejection stack trace:\n${error.stack}`);
    }
  });

  // Ensure background resources like browser pools and knowledge store are cleaned up
  const handleShutdown = (signal: string) => {
    logger.log(`[pi-research] Received ${signal}, initiating cleanup...`);
    shutdownManager.runCleanup(signal).then(() => {
      logger.log(`[pi-research] Cleanup complete, exiting...`);
      // Clean exit after successful cleanup
      process.exit(0);
    }).catch(err => {
      logger.error(`[pi-research] ${signal} cleanup failed:`, err);
      // Force exit after 10 seconds if cleanup hangs (browser pool can take up to 10s)
      shutdownManager.forceExitAfter(10000, 1);
    });
  };

  // Register cleanup tasks in the order they should run in reverse:
  // 1. stopBrowserManager (runs last - slow, up to 10s for pool destruction)
  // 2. shutdownKnowledgeStore (runs second - disposes embedder to prevent DefaultLogger crash)
  // 3. clearAllSessionState (runs third - fast)
  // 4. resetTerminalState (runs first - fast, prevents ghost character leaks on reload)
  shutdownManager.register(async () => {
    await stopBrowserManager();
  });

  shutdownManager.register(async () => {
    await shutdownKnowledgeStore();
  });

  // Clear all session state on shutdown to ensure timeouts are cleared
  shutdownManager.register(() => {
    clearAllSessionState();
  });

  // Destroy HTTP agent to prevent socket leaks on all shutdown paths
  shutdownManager.register(() => {
    const clientAgent = getClientAgent();
    if (clientAgent) {
      clientAgent.destroy();
      logger.log('[pi-research] HTTP agent destroyed');
    }
  });

  // FIX #4: Reset terminal state on shutdown to prevent ghost character leaks
  // This is crucial for /reload scenarios where terminal protocol responses
  // might arrive after the extension stops but before the new instance starts.
  shutdownManager.register(async () => {
    try {
      await resetTerminalState();
      logger.debug('[pi-research] Terminal state reset on shutdown');
    } catch (_error) {
      // Ignore terminal reset errors - stdout might be closed
    }
  });

  // Primary cleanup path for pi -p (print mode) and normal session end.
  // Pi fires session_shutdown from disposeRuntime() before process.exit() so this
  // reliably drains the writer queue and disposes the embedder even in non-signal exits.
  pi.on('session_shutdown', async () => {
    try {
      await shutdownManager.runCleanup('session_shutdown');
    } catch (_err) {
      logger.error('[pi-research] session_shutdown cleanup failed:', _err);
    }
    // Force exit after 5 seconds if cleanup hangs (shouldn't happen normally)
    shutdownManager.forceExitAfter(5000);
  });

  // Signal handlers as a secondary path (interactive mode, external kill, SIGHUP).
  const handleSIGINT = () => handleShutdown('SIGINT');
  const handleSIGTERM = () => handleShutdown('SIGTERM');
  const handleSIGHUP = () => handleShutdown('SIGHUP');

  shutdownManager.registerEventListener(process, 'SIGINT', handleSIGINT);
  shutdownManager.registerEventListener(process, 'SIGTERM', handleSIGTERM);
  shutdownManager.registerEventListener(process, 'SIGHUP', handleSIGHUP);

  // Global extension state for smart dual-sided prompt injection
  let currentTurn = 0;
  let lastInjectionTurn = -10;
  // Reduced cooldown for safety constraints (NO SUBAGENTS should be reinforced frequently)
  const COOLDOWN_TURNS = 3;
  // Match research keywords including common typos (reserach, reseach, resarch, etc)
  const RESEARCH_REGEX = /\b(research|reserach|reseach|resarch|search|web|analyze|investigate)\b/i;

  // Create and register the research tool
  const researchTool: ToolDefinition = createResearchTool();
  pi.registerTool(researchTool);

  // Create and register the health check tool
  const healthTool: ToolDefinition = createHealthTool();
  pi.registerTool(healthTool);

  // /research <query> — direct quick research, no LLM turn.
  pi.registerCommand('research', {
    description: 'Web research a query',
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) return;

      try {
        const { getConfig } = await import('./config.ts');
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
          details: { totalTokens: (result.details as ResearchResultDetails)?.totalTokens ?? 0 },
        });

        ctx.ui.notify('✅ Research complete', 'info');
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[pi-research] /research command failed:', error);

        pi.sendMessage({
          customType: 'research-result',
          content: `**Research failed**\n\n${message}`,
          display: true,
          details: { error: message },
        });

        ctx.ui.notify(`❌ Research failed: ${message}`, 'error');
      }
    },
  });

  // /research-config — consolidated research configuration and management command
  // Replaces: /health, /health-clear, /health-history, /errors, /errors-clear, /errors-export, /knowledge-migrate
  // Usage:
  //   /research-config                    - Opens interactive TUI menu
  //   /research-config <section>          - Direct access to section (health|errors|knowledge|settings|metrics)
  //   /research-config <section> <action>  - Direct action (e.g., health run, errors clear)
  //   
  // Backward compatibility: old commands still work (e.g., /health, /errors)
  pi.registerCommand('research-config', {
    description: 'Research configuration and management (health, errors, knowledge, settings, metrics)',
    handler: async (args, ctx) => {
      await handleResearchConfigCommand(args, ctx, pi);
    },
  });

  // Register backward compatibility aliases for old commands
  // These routes are handled by the consolidated research-config command
  pi.registerCommand('health', {
    description: 'Run system health checks (alias for: /research-config health run)',
    handler: async (args, ctx) => {
      await handleResearchConfigCommand(`health run ${args}`, ctx, pi);
    },
  });

  pi.registerCommand('health-clear', {
    description: 'Clear health check cache (alias for: /research-config health clear)',
    handler: async (_args, ctx) => {
      await handleResearchConfigCommand('health clear', ctx, pi);
    },
  });

  pi.registerCommand('health-history', {
    description: 'View health check history (alias for: /research-config health history)',
    handler: async (_args, ctx) => {
      await handleResearchConfigCommand('health history', ctx, pi);
    },
  });

  pi.registerCommand('errors', {
    description: 'View error report (alias for: /research-config errors view)',
    handler: async (_args, ctx) => {
      await handleResearchConfigCommand('errors view', ctx, pi);
    },
  });

  pi.registerCommand('errors-clear', {
    description: 'Clear error history (alias for: /research-config errors clear)',
    handler: async (_args, ctx) => {
      await handleResearchConfigCommand('errors clear', ctx, pi);
    },
  });

  pi.registerCommand('errors-export', {
    description: 'Export error report (alias for: /research-config errors export)',
    handler: async (args, ctx) => {
      await handleResearchConfigCommand(`errors export ${args}`, ctx, pi);
    },
  });

  pi.registerCommand('knowledge-migrate', {
    description: 'Migrate knowledge store (alias for: /research-config knowledge migrate)',
    handler: async (args, ctx) => {
      await handleResearchConfigCommand(`knowledge migrate ${args}`, ctx, pi);
    },
  });

  // Dual-Sided JIT Prompt Injection (User Input + LLM Output) with Cooldown
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    currentTurn++;
    
    // Do not inject rules into the sub-researchers
    const isResearcher = event.systemPrompt?.toLowerCase().includes('researcher');
    if (isResearcher) {
      return { systemPrompt: event.systemPrompt };
    }

    // 1. Scan User Input
    let needsResearch = RESEARCH_REGEX.test(event.prompt || '');

    // 2. Scan LLM Output (if user didn't explicitly ask)
    if (!needsResearch) {
      const branch = ctx?.sessionManager?.getBranch?.() || [];
      // Grab the last assistant message
      const lastAssistant = [...branch].reverse().find((e: any) => e.type === 'message' && e.message.role === 'assistant');
      if (lastAssistant) {
        needsResearch = RESEARCH_REGEX.test(JSON.stringify(lastAssistant.message.content));
      }
    }

    // 3. Inject ONLY if matched AND cooldown has passed
    if (needsResearch && (currentTurn - lastInjectionTurn >= COOLDOWN_TURNS)) {
      lastInjectionTurn = currentTurn;
      logger.debug('[pi-research] JIT constraint rule injected (Dual-Scan matched).');
      
      const researchPrompt = loadPrompt('research-tool-usage')
        .replace('{MAX_TEAM_SIZE_L1}', MAX_TEAM_SIZE_LEVEL_1.toString())
        .replace('{MAX_TEAM_SIZE_L2}', MAX_TEAM_SIZE_LEVEL_2.toString())
        .replace('{MAX_TEAM_SIZE_L3}', MAX_TEAM_SIZE_LEVEL_3.toString());
      
      return {
        systemPrompt: event.systemPrompt + '\n\n' + researchPrompt
      };
    }

    return { systemPrompt: event.systemPrompt };
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
      if (retryAfter) {
        ctx.ui?.notify?.(`Rate limited. Retry after ${retryAfter}s`, 'warning');
      }
    } else if (status >= 400) {
      logger.warn(`[pi-research] Provider error: ${status}`, { headers });
    }
  });

  // Log health status at startup (non-blocking)
  setTimeout(async () => {
    try {
      const health = await healthRegistry.runAll();
      const statusIcon = health.status === 'healthy' ? '✅' :
                        health.status === 'degraded' ? '⚠️' : '❌';
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
