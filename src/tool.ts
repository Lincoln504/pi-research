/**
 * pi-research: Multi-Agent Research Orchestration Tool
 *
 * This is the primary entry point for the pi-research extension. It handles:
 * 1. Configuration validation and SearXNG infrastructure lifecycle.
 * 2. TUI (Terminal UI) initialization and real-time progress tracking.
 * 3. Branching between "Quick" (single-agent) and "Deep" (multi-agent/multi-round) research modes.
 * 4. Error handling, session cleanup, and result synthesis.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import type {
  ExtendedExtensionContext,
  SessionManager,
  ModelWithId,
  ExtendedAgentSessionEvent,
} from './types/extension-context.ts';
import type { SettingsManager } from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import { createResearcherSession } from "./orchestration/researcher.ts";
import { validateConfig } from './config.ts';
import {
  createMasterResearchPanel,
  addSlice,
  activateSlice,
  completeSlice,
  removeSlice,
  updateSliceTokens,
  createInitialPanelState,
  clearAllFlashTimeouts,
  flashSlice,
} from './tui/research-panel.ts';
import { ensureAssistantResponse } from './utils/text-utils.ts';
import { isTextContentBlock, parseTokenUsage, calculateTotalTokens } from './types/llm.ts';
import { DeepResearchOrchestrator } from './orchestration/deep-research-orchestrator.ts';
import { createResearchRunId, logger, runWithLogContext } from './logger.ts';
import { exportResearchReport, appendExportMessage } from './utils/research-export.ts';
import { validateAndSanitizeQuery } from './utils/input-validation.ts';
import { injectCurrentDate } from './utils/inject-date.ts';
import {
  startResearchSession,
  endResearchSession,
  registerSessionPanel,
  registerMasterUpdate,
  refreshAllSessions,
  onSessionOrderChange,
  getPiActivePanels,
} from './utils/session-state.ts';
import { cleanupSharedLinks } from './utils/shared-links.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Functional Health Check for Tool Start
 * 
 * Ensures browser binaries are ready.
 */
async function ensureFunctionalHealth(
  panelState: any, 
  onUpdate: () => void
): Promise<void> {
  const sliceLabel = 'health check ...';
  addSlice(panelState, sliceLabel, sliceLabel, false);
  activateSlice(panelState, sliceLabel);
  onUpdate();

  try {
    const { runHealthCheck } = await import('./healthcheck/index.ts');
    const health = await runHealthCheck();
    
    if (!health.success) {
      throw new Error(`Functional health check failed: ${health.error || 'Unknown error'}. Your network or browser may be blocked.`);
    }
  } finally {
    removeSlice(panelState, sliceLabel);
    onUpdate();
  }
}

function getPiSessionMetadata(ctx: ExtensionContext) {
  const extendedCtx = ctx as ExtendedExtensionContext;
  const sessionManager: SessionManager | undefined = extendedCtx.sessionManager;
  const piSessionId = typeof sessionManager?.getSessionId === 'function' ? String(sessionManager.getSessionId()) : 'default';
  return {
    piSessionId,
    sessionFile: typeof sessionManager?.getSessionFile === 'function' ? String(sessionManager.getSessionFile()) : undefined,
    cwd: ctx.cwd,
  };
}

export function createResearchTool(): ToolDefinition {
  return {
    name: 'research',
    label: 'Research',
    description:
      'Perform deep web/internet research using a coordinated team of agents. Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct multi-agent web/internet research',
    promptGuidelines: [
      'Specifically for web research, not local project exploration.',
      'Research is organized into Rounds. Each round contains multiple parallel siblings.',
      'SCRAPE PROTOCOL: Call the `scrape` tool up to FOUR times per agent: (1) handshake returns globally scraped links, (2) Batch 1 broad scrape ≤3 URLs, (3) Batch 2 targeted ≤2 URLs, (4) Batch 3 deep-dive ≤3 URLs. Batches skip automatically when context > 55%.',
      'The last sibling in each round evaluates progress and decides whether to continue or synthesize.',
      '`security_search` is available for vulnerabilities, CVE IDs, package security, or actively exploited vulnerabilities.',
      '`stackexchange` is available for technical questions, code solutions, debugging help, and best practices.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      depth: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 3,
        description: [
          'Research complexity level (0-3).',
          '0: Quick/Brief — 1 researcher, 1 round. Direct session; no coordinator/orchestrator.',
          '1: Normal — 2 researchers, 2 rounds. AI-orchestrated.',
          '2: Deep — 3 researchers, 3 rounds. AI-orchestrated.',
          '3: Ultra — 5 researchers, 5 rounds (Exhaustive). AI-orchestrated.',
          'Omit to use default complexity 0 (Quick mode).',
        ].join(' '),
      })),
      model: Type.Optional(Type.String({
        description: 'Model ID to use for all research agents (defaults to current active model)',
      })),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { query, model: modelId, depth } = params as {
        query: string;
        depth?: number;
        model?: string;
      };

      if (!query || !ctx.model) {
        return { content: [{ type: 'text', text: 'Error: query and model are required' }], details: {} };
      }

      // Validate and sanitize query
      const sanitizedQuery = validateAndSanitizeQuery(query);

      const baseModel = ctx.model;
      const researchRunId = createResearchRunId();
      const metadata = getPiSessionMetadata(ctx);
      const piSessionId = metadata.piSessionId;

      return runWithLogContext({
        ...metadata,
        researchRunId,
        toolName: 'research',
      }, async () => {
        let aborted = false;
        let cleanup: (() => void) | null = null;
        let unsubOrder: (() => void) | null = null;

        try {
          validateConfig();

          let selectedModel = baseModel;
          if (modelId) {
            selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;
          }

          const typedModel = selectedModel as ModelWithId;
          const modelIdStr = typedModel?.id || 'unknown';

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;

          cleanup = () => {
            if (unsubOrder) unsubOrder();
            endResearchSession(piSessionId, researchId);
            cleanupSharedLinks(researchId);
            // Clear all flash timeouts for this specific run
            clearAllFlashTimeouts(researchId);
            
            // If no more research runs are active in this Pi session, remove the master widget
            const activePanels = getPiActivePanels(piSessionId);
            if (activePanels.length === 0) {
              ctx.ui.setWidget(masterWidgetId, undefined);
            } else {
              // Otherwise, just refresh to remove this run's block
              refreshAllSessions(piSessionId);
            }
            
            logger.info('[research] cleanup completed', { piSessionId, researchId });
          };

          const panelState = createInitialPanelState(researchId, sanitizedQuery, modelIdStr);
          
          // Register this research run's state and the master update function
          registerSessionPanel(piSessionId, researchId, panelState);
          const updateMasterWidget = () => {
            const masterPanelCreator = createMasterResearchPanel(piSessionId, getPiActivePanels);
            ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => masterPanelCreator(theme), { placement: 'aboveEditor' });
          };
          registerMasterUpdate(piSessionId, updateMasterWidget);
          
          // Subscribe to order changes to ensure refresh when ANY run starts/ends
          unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

          // Robust functional health check before research starts
          await ensureFunctionalHealth(panelState, () => refreshAllSessions(piSessionId));

          const onTokens = (n: number) => {
            panelState.totalTokens += n;
            refreshAllSessions(piSessionId);
          };

          // Default complexity to 0 (quick mode) if not provided
          const researchComplexity = depth ?? 0;
          const isQuick = researchComplexity === 0;

          // For deep mode, complexity (1-3) is passed directly to orchestrator
          // complexity 1 → Normal (2 researchers, 2 rounds)
          // complexity 2 → Deep (3 researchers, 3 rounds)
          // complexity 3 → Ultra (5 researchers, 5 rounds)
          const orchestratorComplexity = researchComplexity as 1 | 2 | 3;

          logger.info('[research] run initialized', {
            mode: isQuick ? 'quick' : 'deep',
            complexity: researchComplexity,
            piSessionId,
            researchId,
            selectedModelId: modelIdStr,
          });

          signal?.addEventListener('abort', () => {
            aborted = true;
            logger.warn('[research] run aborted', { piSessionId, researchId });
            cleanup?.();
          }, { once: true });

          if (isQuick) {
            const truncatedQuery = sanitizedQuery.length > 20 ? sanitizedQuery.slice(0, 20) + '...' : sanitizedQuery;
            const sliceLabel = `researching: ${truncatedQuery}`;
            addSlice(panelState, sliceLabel, sliceLabel, false);
            activateSlice(panelState, sliceLabel);
            // Quick mode: deterministic tool limits
            // - 4 gathering calls (search/security/stackexchange/grep combined)
            // - 4 scrape calls (handshake + 3 batches)
            // Total: 8 tool calls, then STOP
            panelState.progress = { expected: 8, made: 0, extended: false };
            logger.info('[research] quick mode started', { query: sanitizedQuery });
            refreshAllSessions(piSessionId);
            const researcherPromptRaw = readFileSync(join(__dirname, 'prompts', 'researcher.md'), 'utf-8');
            let researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher');
            
            // QUICK MODE EFFICIENCY: Encourage early exit ONLY for definitive fact-finding.
            researcherPrompt += '\n\n## Quick Mode Efficiency\n' +
              'For specific fact-seeking queries: if you find a definitive, up-to-date answer from a highly reliable source ' +
              'that fully resolves the request, stop gathering/scraping immediately and provide a concise, high-signal report.';
            
            const extendedCtx = ctx as ExtendedExtensionContext;

            // Per-session token accumulator for context-aware scrape gating
            let quickSessionTokens = 0;
            const quickContextWindowSize = (selectedModel as any)?.contextWindow ?? 200000;

            const session = await createResearcherSession({
              cwd: ctx.cwd,
              ctxModel: selectedModel,
              modelRegistry: ctx.modelRegistry,
              settingsManager: extendedCtx.settingsManager || (ctx as unknown as { settingsManager: SettingsManager }).settingsManager!,
              systemPrompt: researcherPrompt,
              extensionCtx: ctx,
              getTokensUsed: () => quickSessionTokens,
              contextWindowSize: quickContextWindowSize,
            });
            
            const calculateUsageCost = (usage: Partial<import('./types/llm').TokenUsage>): number => {
              if (!usage || !selectedModel?.cost) return 0;
              const modelCost = selectedModel.cost;
              const inputCost = (modelCost.input / 1_000_000) * (usage.input ?? 0);
              const outputCost = (modelCost.output / 1_000_000) * (usage.output ?? 0);
              const cacheReadCost = (modelCost.cacheRead / 1_000_000) * (usage.cacheRead ?? 0);
              const cacheWriteCost = (modelCost.cacheWrite / 1_000_000) * (usage.cacheWrite ?? 0);
              return inputCost + outputCost + cacheReadCost + cacheWriteCost;
            };

            const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
              if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const usage = parseTokenUsage(event.message?.usage);
                const tokens = calculateTotalTokens(usage);
                const cost = calculateUsageCost(usage);
                if (tokens > 0) {
                  quickSessionTokens += tokens; // drives context-aware scrape gating
                  onTokens(tokens);
                  updateSliceTokens(panelState, sliceLabel, tokens, cost);
                  refreshAllSessions(piSessionId);
                }
              } else if (event.type === 'message_update') {
                // Estimate context growth from streaming text during model generation.
                // Cost is left unchanged (only updated with exact values on message_end).
                const updateMsg = event.message;
                // Content may be in the message object but not typed in ExtendedAgentSessionEvent
                const content = updateMsg?.role === 'assistant' ? (updateMsg as any).content : undefined;
                if (Array.isArray(content)) {
                  const textLen = content
                    .filter(isTextContentBlock)
                    .reduce((sum, b) => sum + b.text.length, 0);
                  if (textLen > 200) {
                    const estimated = quickSessionTokens + Math.ceil(textLen / 4);
                    updateSliceTokens(panelState, sliceLabel, estimated, 0);
                    refreshAllSessions(piSessionId);
                  }
                }
              } else if (event.type === 'tool_execution_end') {
                const isError = event.isError ?? false;
                const isBlocked = event.details?.blocked === true;
                const color = isError || isBlocked ? 'red' : 'green';
                const duration = isError || isBlocked ? 1000 : 500;
                flashSlice(panelState, sliceLabel, color, duration, () => refreshAllSessions(piSessionId));
                // Advance progress bar ONLY for non-blocked tool calls
                if (panelState.progress && !isBlocked) {
                  panelState.progress.made += 1;
                  // Snap to 100% when all tool calls are used
                  if (panelState.progress.made >= panelState.progress.expected) {
                    panelState.progress.made = panelState.progress.expected;
                  }
                  refreshAllSessions(piSessionId);
                }
              }
            });

            // Race the session prompt against the abort signal so the tool returns
            // immediately on Ctrl+C rather than waiting for the session to finish.
            // The session itself continues running in the background (pi SDK limitation),
            // but the tool call resolves and the user gets a responsive cancel.
            if (signal) {
              await Promise.race([
                session.prompt(sanitizedQuery),
                new Promise<never>((_, reject) => {
                  if (signal.aborted) { reject(new Error('Research aborted')); return; }
                  signal.addEventListener('abort', () => reject(new Error('Research aborted')), { once: true });
                }),
              ]);
            } else {
              await session.prompt(sanitizedQuery);
            }
            const result = ensureAssistantResponse(session, 'Quick');

            // Snap to 100%
            if (panelState.progress) {
              panelState.progress.made = panelState.progress.expected;
              refreshAllSessions(piSessionId);
            }

            // Export research report
            const exportPath = await exportResearchReport(sanitizedQuery, result, 'quick', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

            // Cleanup subscription
            if (typeof subscription === 'function') {
              subscription();
            }

            completeSlice(panelState, sliceLabel);
            cleanup();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
          } else {
            // DEEP MODE: orchestrator complexity has already been determined above.
            const orchestrator = new DeepResearchOrchestrator({
              ctx,
              model: selectedModel as Model<any>,
              query: sanitizedQuery,
              complexity: orchestratorComplexity,
              onTokens,
              onUpdate: () => refreshAllSessions(piSessionId),
              panelState,
            });

            const result = await orchestrator.run(signal);
            
            // Export research report
            const exportPath = await exportResearchReport(sanitizedQuery, result, 'deep', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

            cleanup();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
          }
        } catch (error) {
          // If aborted, don't treat as error - just return gracefully
          if (aborted) {
            return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
          }
          cleanup?.();
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error('[research] run failed', error);
          return { content: [{ type: 'text', text: `Research failed: ${errorMsg}` }], details: {} };
        }
      });
    },
  };
}
