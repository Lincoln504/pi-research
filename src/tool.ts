/**
 * Research Tool
 *
 * Main orchestration logic for research tool.
 * Creates coordinator session that naturally calls delegate_research and investigate_context tools.
 * Initializes SearXNG on first call (lazy initialization).
 *
 * TUI: Two-box layout (SearXNG status + researcher columns)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
  AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { SessionManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createCoordinatorSession } from './orchestration/coordinator.ts';
import { createResearcherSession } from "./orchestration/researcher.ts";
import { validateConfig, getConfig } from './config.ts';
import {
  createResearchPanel,
  clearAllFlashTimeouts,
  addSlice,
  activateSlice,
  completeSlice,
  flashSlice,
  createInitialPanelState,
} from './tui/research-panel.ts';
import { formatParentContext } from './orchestration/session-context.ts';
import { extractText, ensureAssistantResponse } from './utils/text-utils.ts';
import {
  initLifecycle,
  ensureRunning,
  getStatus,
  onStatusChange,
  type SearxngStatus,
  getConnectionCount,
} from './infrastructure/searxng-lifecycle.ts';
import { getManager } from './infrastructure/searxng-lifecycle.ts';
import { onConnectionCountChange } from './web-research/utils.ts';
import { createDelegateTool, type DelegateToolOptions } from './orchestration/delegate-tool.ts';
import { createInvestigateContextTool } from './orchestration/context-tool.ts';
import type { CreateResearcherSessionOptions } from './orchestration/researcher.ts';
import { logger, suppressConsole } from './logger.ts';
import { injectCurrentDate } from './utils/inject-date.ts';
import {
  startResearchSession,
  endResearchSession,
  isBottomMostSession,
  onSessionOrderChange,
  registerSessionUpdate,
  refreshAllSessions,
  clearPendingRefresh,
} from './utils/session-state.ts';
import { cleanupSharedLinks } from './utils/shared-links.ts';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export function createResearchTool(): ToolDefinition {
  return {
    name: 'research',
    label: 'Research',
    description:
      'Perform deep web/internet research using a multi-agent orchestration (not for local file or project exploration). Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct multi-agent web/internet research',
    promptGuidelines: [
      'Specifically for web research, not local project exploration.',
      'Accepts a query, an optional model (defaults to yours), and an optional quick flag for simple lookups.',
      'For normal research (no quick), form the query with appropriate depth, specificity, and scope.',
      'The coordinator breaks down query into research aspects.',
      'Researchers investigate using web search, scraping, security databases, and more.',
      'Results are synthesized into a final comprehensive answer.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      quick: Type.Optional(Type.Boolean({
        description: 'Enable quick mode: fast investigation using a single researcher session without a coordinator.',
        default: false,
      })),
      model: Type.Optional(Type.String({
        description: 'Model ID to use for all research agents (defaults to the currently active model)',
      })),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { query, model: modelId, quick: isQuick = false } = params as { query: string; quick?: boolean; model?: string };

      // Suppress ALL console output immediately — catches SearXNG Manager init messages,
      // internal module logs, and any other module that uses console.* directly.
      // Output goes to log file when --verbose, otherwise silenced entirely.
      const restoreConsole = suppressConsole();

      // 1. Validate
      if (!query) {
        restoreConsole();
        return {
          content: [{ type: 'text', text: 'Error: query is required' }],
          details: {},
        };
      }

      if (!ctx.model) {
        restoreConsole();
        return {
          content: [{ type: 'text', text: 'Error: No model selected. Please select a model before using the research tool.' }],
          details: {},
        };
      }

      // 2. Config
      try {
        validateConfig();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error('[research] Invalid configuration:', errorMsg);
        restoreConsole();
        return {
          content: [
            {
              type: 'text',
              text: `Error: Invalid configuration - ${errorMsg}. Check environment variables.`,
            },
          ],
          details: {},
        };
      }

      // 3. Resolve model — use specified model ID if valid, else fall back to active model
      let selectedModel = ctx.model;
      if (modelId) {
        const found = ctx.modelRegistry.getAll().find((m) => m.id === modelId);
        if (found) {
          selectedModel = found;
          logger.log(`[research] Using model: ${modelId}`);
        } else {
          logger.warn(`[research] Model '${modelId}' not found, falling back to active model`);
        }
      }

      logger.log('[research] Starting research orchestration:', { query: query.slice(0, 50) });

      // 4. Init SearXNG
      try {
        await initLifecycle(ctx);
      } catch (error) {
        logger.error('[research] Failed to initialize SearXNG:', error);
        restoreConsole();
        return {
          content: [
            {
              type: 'text',
              text: `Error: Failed to initialize SearXNG: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
        };
      }

      let searxngUrl: string;
      try {
        searxngUrl = await ensureRunning();

        // Register manager with web-research module
        try {
          const manager = getManager();
          if (manager) {
            const { setSearxngManager } = await import('./web-research/utils.ts');
            setSearxngManager(manager);
            logger.debug('[research] Registered SearXNG manager with web-research module');
          }
        } catch (regError) {
          logger.warn('[research] Could not register SearXNG manager:', regError instanceof Error ? regError.message : String(regError));
        }
      } catch (error) {
        logger.error('[research] Failed to ensure SearXNG running:', error);
        restoreConsole();
        return {
          content: [
            {
              type: 'text',
              text: `Error: Failed to ensure SearXNG running: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
        };
      }

      // Unique widget ID for simultaneous research sessions
      // This allows multiple panels to stack in the UI
      const sessionId = startResearchSession();
      const widgetId = `pi-research-panel-${sessionId}`;

      // 5. Setup TUI
      const searxngStatus = getStatus();
      const modelName = (selectedModel as any)?.id ?? 'unknown';
      const panelState = createInitialPanelState(sessionId, searxngStatus, modelName);

      // Widget update function — coordinated via refreshAllSessions
      // Note: pi's 'aboveEditor' placement appends widgets in registration order.
      // This means the first-registered session (oldest) is closest to the editor.
      const updateWidget = () => {
        try {
          // Only show SearXNG box if this is the bottom-most active research session
          panelState.hideSearxng = !isBottomMostSession(sessionId);
          ctx.ui.setWidget(widgetId, createResearchPanel(panelState), { placement: 'aboveEditor' });
        } catch (error) {
          logger.error(`Error updating widget for session ${sessionId}:`, error);
        }
      };

      // Register this session's update function globally to coordinate re-renders
      // This automatically triggers a refresh via notifyOrderChange
      registerSessionUpdate(sessionId, updateWidget);

      // Subscribe to SearXNG status changes
      const unsubStatus = onStatusChange((status: SearxngStatus) => {
        panelState.searxngStatus = status;
        panelState.activeConnections = getConnectionCount();
        refreshAllSessions();
      });
      // Subscribe to connection count changes for real-time updates
      const unsubConnectionCount = onConnectionCountChange((count: number) => {
        panelState.activeConnections = count;
        refreshAllSessions();
      });

      // Subscribe to session order changes (to restore SearXNG box on bottom-most panel)
      const unsubOrder = onSessionOrderChange(() => {
        refreshAllSessions();
      });

      logger.log(`[research] Started research session: ${sessionId}`);
      // Cleanup function — idempotent
      // restoreConsole is delayed 15s to absorb pending SearXNG HTTP timeout callbacks
      // that fire console.warn after the research is done (internal module logging).
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        logger.log('[research] Cleaning up...');

        try {
          endResearchSession(sessionId);  // Clear session state
        } catch (error) {
          logger.warn(`[research] Error ending research session ${sessionId}:`, error);
        }

        try {
          cleanupSharedLinks(sessionId);  // Clean up shared links pool file
        } catch (error) {
          logger.warn(`[research] Error cleaning up shared links for session ${sessionId}:`, error);
        }

        unsubStatus();
        unsubConnectionCount();
        unsubOrder();
        clearAllFlashTimeouts(sessionId);

        try {
          ctx.ui.setWidget(widgetId, undefined);
        } catch (error) {
          logger.warn(`[research] Error clearing widget for session ${sessionId}:`, error);
        }

        // Clear any pending global refresh and do a final refresh with remaining sessions
        clearPendingRefresh();
        refreshAllSessions(); // Re-render remaining panels to update SearXNG box visibility
        setTimeout(restoreConsole, getConfig().CONSOLE_RESTORE_DELAY_MS).unref?.();
      };
      signal?.addEventListener('abort', cleanup, { once: true });

      // 6. Shared session infrastructure
      const sessionManager = SessionManager.inMemory();
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
      const researcherPromptRaw = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');
      const researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher');

      const researcherOptions: CreateResearcherSessionOptions = {
        cwd: ctx.cwd,
        ctxModel: selectedModel,
        modelRegistry: ctx.modelRegistry,
        settingsManager,
        systemPrompt: researcherPrompt,
        searxngUrl,
        extensionCtx: ctx,
      };

      // 8. Shared token tracking function
      const onTokens = (n: number) => {
        panelState.totalTokens += n;
        refreshAllSessions();
      };

      // 9. Create internal abort controller
      const researchAbortController = new AbortController();
      const combinedSignal = AbortSignal.any([signal ?? AbortSignal.timeout(86400000), researchAbortController.signal]);
      const abortHandler = () => {
        researchAbortController.abort();
      };
      signal?.addEventListener('abort', abortHandler, { once: true });

      // 10. Branch: Quick mode vs Deep mode
      if (isQuick) {
        // ===== QUICK MODE: Single researcher, no coordinator =====
        const sliceLabel = 'researching ...';
        addSlice(panelState, sliceLabel, sliceLabel, false);
        activateSlice(panelState, sliceLabel);
        refreshAllSessions();

        try {
          // Create researcher session
          const researcherSession = await createResearcherSession(researcherOptions);

          // Subscribe to session events
          researcherSession.subscribe((event: AgentSessionEvent) => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
              const tokens = (event.message as any).usage?.totalTokens;
              if (tokens) onTokens(tokens);
            }
            if (event.type === 'tool_execution_end') {
              const color = (event as any).error ? 'red' : 'green';
              flashSlice(panelState, sliceLabel, color, 1000, refreshAllSessions);
            }
          });

          // Prompt researcher with full query
          let timeoutId: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              researcherSession.prompt(query),
              new Promise<void>((_, reject) => {
                if (combinedSignal.aborted) {
                  reject(new Error('Research cancelled by user'));
                  return;
                }
                timeoutId = setTimeout(() => {
                  reject(new Error(`Quick researcher timeout after ${getConfig().RESEARCHER_TIMEOUT_MS}ms`));
                }, getConfig().RESEARCHER_TIMEOUT_MS);
                combinedSignal.addEventListener('abort', () => {
                  if (timeoutId) clearTimeout(timeoutId);
                  reject(new Error('Research cancelled by user'));
                });
              })
            ]);
          } finally {
            // Clean up timeout when prompt completes (success or failure)
            if (timeoutId) clearTimeout(timeoutId);
          }

          // Complete research and extract result
          completeSlice(panelState, sliceLabel);
          refreshAllSessions();

          const msgs = researcherSession.messages;
          const last = [...msgs].reverse().find((m: any) => m.role === 'assistant');
          const text = extractText(last) || 'No answer found.';

          completeSlice(panelState, sliceLabel);
          updateWidget();
          cleanup();
          return { content: [{ type: 'text', text }], details: { totalTokens: panelState.totalTokens } };
        } catch (error) {
          cleanup();
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('cancelled by user') || combinedSignal.aborted) {
            return {
              content: [{ type: 'text', text: 'Research cancelled by user (ESC/Ctrl+C)' }],
              details: {},
            };
          }
          return {
            content: [{ type: 'text', text: `Quick research failed: ${errorMsg}` }],
            details: {},
          };
        } finally {
          signal?.removeEventListener('abort', abortHandler);
        }
      } else {
        // ===== DEEP MODE: Coordinator + multi-researcher =====
        const breadthCounter = { value: 0 };
        const coordinatorPromptRaw = readFileSync(join(__dirname, '..', 'prompts', 'coordinator.md'), 'utf-8');
        const coordinatorPrompt = injectCurrentDate(coordinatorPromptRaw, 'coordinator');

        const delegateToolOptions: DelegateToolOptions = {
          sessionId,
          breadthCounter,
          panelState,
          onTokens,
          onUpdate: updateWidget,
          researcherOptions,
          signal,
          timeoutMs: getConfig().RESEARCHER_TIMEOUT_MS,
          flashTimeoutMs: 1000,
        };
        const delegateTool = createDelegateTool(delegateToolOptions);
        const contextTool = createInvestigateContextTool({
          cwd: ctx.cwd,
          ctxModel: selectedModel,
          modelRegistry: ctx.modelRegistry,
        });

        // Create coordinator session
        const coordinatorSession = await createCoordinatorSession({
          cwd: ctx.cwd,
          ctxModel: selectedModel,
          modelRegistry: ctx.modelRegistry,
          sessionManager,
          settingsManager,
          systemPrompt: coordinatorPrompt,
          customTools: [delegateTool, contextTool],
        });

        // Token tracking for coordinator
        coordinatorSession.subscribe((event: AgentSessionEvent) => {
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const tokens = (event.message as any).usage?.totalTokens;
            if (tokens) onTokens(tokens);
          }
        });

        // Execute coordinator
        try {
          const context = formatParentContext(ctx);
          await Promise.race([
            coordinatorSession.prompt(`Context:\n${context}\n\nQuery: ${query}`),
            new Promise((_, reject) => {
              if (combinedSignal.aborted) {
                reject(new Error('Research cancelled by user'));
              } else {
                combinedSignal.addEventListener('abort', () => {
                  reject(new Error('Research cancelled by user'));
                });
              }
            })
          ]);
          
          const text = ensureAssistantResponse(coordinatorSession, 'coordinator') || 'No answer synthesized.';
          cleanup();
          return { content: [{ type: 'text', text }], details: { totalTokens: panelState.totalTokens } };
        } catch (error) {
          coordinatorSession.abort().catch(() => {});
          cleanup();
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('cancelled by user') || combinedSignal.aborted) {
            return {
              content: [{ type: 'text', text: 'Research cancelled by user (ESC/Ctrl+C)' }],
              details: {},
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: `Research failed: ${errorMsg}`,
              },
            ],
            details: {},
          };
        } finally {
          signal?.removeEventListener('abort', abortHandler);
        }
      }
    },
  };
}
