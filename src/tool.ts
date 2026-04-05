/**
 * Research Tool
 *
 * Main orchestration logic for research tool.
 * Creates coordinator session that naturally calls delegate_research and investigate_context tools.
 * Initializes SearXNG on first call (lazy initialization).
 *
 * TUI: Two-box layout (SearXNG status + slice columns)
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
import { createCoordinatorSession } from './orchestration/coordinator.js';
import { createResearcherSession } from "./orchestration/researcher.js";
import { validateConfig, RESEARCHER_TIMEOUT_MS, FLASH_TIMEOUT_MS } from './config.js';
import {
  createResearchPanel,
  clearAllFlashTimeouts,
  addSlice,
  activateSlice,
  completeSlice,
  flashSlice,
  type ResearchPanelState,
} from './tui/research-panel.js';
import { formatParentContext } from './orchestration/session-context.js';
import { extractText } from './utils/text-utils.js';
import {
  initLifecycle,
  ensureRunning,
  getStatus,
  onStatusChange,
  type SearxngStatus,
  getConnectionCount,
} from './searxng-lifecycle.js';
import { getManager } from './searxng-lifecycle.js';
import { onConnectionCountChange } from './web-research/utils.js';
import { createDelegateTool, type DelegateToolOptions } from './orchestration/delegate-tool.js';
import { createInvestigateContextTool } from './orchestration/context-tool.js';
import type { CreateResearcherSessionOptions } from './orchestration/researcher.js';
import { logger, suppressConsole } from './logger.js';
import { startResearchSession, endResearchSession } from './utils/session-state.js';
import { generateSessionId, cleanupSharedLinks } from './utils/shared-links.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export function createResearchTool(): ToolDefinition {
  return {
    name: 'research',
    label: 'Research',
    description:
      'Orchestrate multi-agent research: coordinator delegates to parallel/sequential researchers, synthesizes findings. Uses web search, scraping, security databases, and code search.',
    promptSnippet: 'Conduct multi-agent research on a topic',
    promptGuidelines: [
      'Use research to investigate complex topics requiring multiple perspectives.',
      'The coordinator breaks down query into research slices.',
      'Researchers investigate using web search, scraping, security databases, and code search.',
      'Results are synthesized into a final comprehensive answer.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      depth: Type.Optional(Type.String({
        description: 'Research depth: "quick" (single researcher, no coordinator, fast) or "deep" (coordinator + multi-agent, default)',
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
      const { query, model: modelId } = params as { query: string; depth?: string; model?: string };
      const depthParam = ((params as any).depth as string | undefined)?.toLowerCase() ?? 'deep';
      const isQuick = depthParam === 'quick';

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
        const found = ctx.modelRegistry.getAll().find((m: any) => m.id === modelId);
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
            const { setSearxngManager } = await import('./web-research/utils.js');
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

      // 5. Setup TUI
      const searxngStatus = getStatus();
      const panelState: ResearchPanelState = {
        searxngStatus,
        totalTokens: 0,
    activeConnections: 0,
        slices: new Map(),
        modelName: (selectedModel as any)?.id ?? 'unknown',
      };

      // Widget update function - re-sets widget to trigger re-render
      // Widgets don't support requestRender(), so we must re-set the widget
      const updateWidget = () => {
        ctx.ui.setWidget('pi-research-panel', createResearchPanel(panelState), { placement: 'aboveEditor' });
      };

      ctx.ui.setWidget('pi-research-panel', createResearchPanel(panelState), { placement: 'aboveEditor' });
      // Subscribe to SearXNG status changes
      const unsubStatus = onStatusChange((status: SearxngStatus) => {
        panelState.searxngStatus = status;
        panelState.activeConnections = getConnectionCount();
        updateWidget();
      });
      // Subscribe to connection count changes for real-time updates
      const unsubConnectionCount = onConnectionCountChange((count: number) => {
        panelState.activeConnections = count;
        updateWidget();
      });
      // Start research session for robust failure tracking
      const sessionBaseId = startResearchSession();
      const sessionId = generateSessionId(sessionBaseId);
      logger.log(`[research] Started research session: ${sessionId}`);
      // Cleanup function — idempotent
      // restoreConsole is delayed 15s to absorb pending SearXNG HTTP timeout callbacks
      // that fire console.warn after the research is done (internal module logging).
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        logger.log('[research] Cleaning up...');
        endResearchSession();  // Clear session state
        cleanupSharedLinks(sessionId);  // Clean up shared links pool file
        unsubStatus();
        unsubConnectionCount();
        clearAllFlashTimeouts();
        ctx.ui.setWidget('pi-research-panel', undefined);
        setTimeout(restoreConsole, 15000).unref?.();
      };
      signal?.addEventListener('abort', cleanup, { once: true });

      // 6. Shared session infrastructure
      const sessionManager = SessionManager.inMemory();
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
      const researcherPrompt = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');

      const researcherOptions: CreateResearcherSessionOptions = {
        cwd: ctx.cwd,
        ctxModel: selectedModel,
        modelRegistry: ctx.modelRegistry,
        sessionManager,
        settingsManager,
        systemPrompt: researcherPrompt,
        searxngUrl,
        extensionCtx: ctx,
      };

      // 8. Shared token tracking function
      const onTokens = (n: number) => {
        panelState.totalTokens += n;
        updateWidget();
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
        const sliceLabel = '1:1';
        addSlice(panelState, sliceLabel, sliceLabel, false);
        activateSlice(panelState, sliceLabel);
        updateWidget();

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
              flashSlice(panelState, sliceLabel, color, FLASH_TIMEOUT_MS, updateWidget);
            }
          });

          // Prompt researcher with full query
          const context = formatParentContext(ctx);
          let timeoutId: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              researcherSession.prompt(`Context:\n${context}\n\nQuery: ${query}`),
              new Promise<void>((_, reject) => {
                if (combinedSignal.aborted) {
                  reject(new Error('Research cancelled by user'));
                  return;
                }
                timeoutId = setTimeout(() => {
                  reject(new Error(`Quick researcher timeout after ${RESEARCHER_TIMEOUT_MS}ms`));
                }, RESEARCHER_TIMEOUT_MS);
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

          // Extract result
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
        const coordinatorPrompt = readFileSync(join(__dirname, '..', 'prompts', 'coordinator.md'), 'utf-8');

        const delegateToolOptions: DelegateToolOptions = {
          sessionId,
          breadthCounter,
          panelState,
          onTokens,
          onUpdate: updateWidget,
          researcherOptions,
          signal,
          timeoutMs: RESEARCHER_TIMEOUT_MS,
          flashTimeoutMs: FLASH_TIMEOUT_MS,
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
          const msgs = coordinatorSession.messages;
          const last = [...msgs].reverse().find((m) => m.role === 'assistant');
          const text = extractText(last) || 'No answer synthesized.';
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
