/**
 * Research Tool
 *
 * Main orchestration logic for research tool.
 * Orchestrates deep mode research with multiple parallel agents.
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
import { complete } from '@mariozechner/pi-ai';
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
import {
  initLifecycle,
  ensureRunning,
  getStatus,
  isFunctional,
  setFunctional,
} from './infrastructure/searxng-lifecycle.ts';
import { getManager } from './infrastructure/searxng-lifecycle.ts';
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
 * Ensures SearXNG is not just running, but actually returning results.
 * Shows status in TUI while running.
 */
async function ensureFunctionalHealth(
  panelState: any, 
  onUpdate: () => void
): Promise<void> {
  if (isFunctional()) return;

  const sliceLabel = 'health check ...';
  addSlice(panelState, sliceLabel, sliceLabel, false);
  activateSlice(panelState, sliceLabel);
  onUpdate();

  try {
    const { runHealthCheck } = await import('./healthcheck/index.ts');
    const health = await runHealthCheck();
    
    if (!health.success) {
      throw new Error(`Functional health check failed: ${health.error || 'Unknown error'}. Your network or search engines may be blocked.`);
    }
    
    setFunctional(true);
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
      'SCRAPE PROTOCOL: Call the `scrape` tool up to FOUR times per agent: (1) handshake returns globally scraped links, (2) Batch 1 broad scrape ≤3 URLs, (3) Batch 2 targeted ≤2 URLs, (4) optional Batch 3 deep-dive ≤3 URLs if context < 40%. Batches skip automatically when context > 50%.',
      'The last sibling in each round evaluates progress and decides whether to continue or synthesize.',
      'Use `security_search` for vulnerabilities, CVE IDs, package security, or actively exploited vulnerabilities.',
      'Use `stackexchange` for technical questions, code solutions, debugging help, and best practices.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      depth: Type.Optional(Type.Union([
        Type.Literal('brief'),
        Type.Literal('normal'),
        Type.Literal('deep'),
        Type.Literal('ultra'),
      ], {
        description: [
          'Research depth. Overrides quick flag and LLM complexity assessment.',
          '"brief"  — single researcher, fast (equivalent to quick mode).',
          '"normal" — 2 initial researchers, up to 3 rounds.',
          '"deep"   — 3 initial researchers, up to 3 rounds (default when omitted and topic is complex).',
          '"ultra"  — 5 initial researchers, up to 5 rounds; use for exhaustive investigation.',
        ].join(' '),
      })),
      quick: Type.Optional(Type.Boolean({
        description: 'Enable quick mode: fast investigation using a single researcher session. Ignored when depth is specified.',
        default: false,
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
      const { query, model: modelId, quick: isQuickParam = false, depth } = params as {
        query: string;
        quick?: boolean;
        depth?: 'brief' | 'normal' | 'deep' | 'ultra';
        model?: string;
      };

      // depth overrides the quick flag entirely.
      // brief  → quick mode (single researcher)
      // normal → complexity 2, skip LLM assessment
      // deep   → complexity 3, skip LLM assessment
      // ultra  → complexity 4, skip LLM assessment
      // (none) → respect quick flag; if not quick, LLM assesses 1–3 as before
      const isQuick = depth === 'brief' ? true : depth ? false : isQuickParam;

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

        try {
          logger.info('[research] run started', { quick: isQuick, modelId });
          validateConfig();
          await initLifecycle(ctx);
          const searxngUrl = await ensureRunning();
          const manager = getManager();
          if (manager) {
            const { setSearxngManager } = await import('./web-research/utils.ts');
            setSearxngManager(manager);
          }

          let selectedModel = baseModel;
          if (modelId) {
            selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;
          }

          const typedModel = selectedModel as ModelWithId;
          const modelIdStr = typedModel?.id || 'unknown';

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;
          const panelState = createInitialPanelState(researchId, sanitizedQuery, getStatus(), modelIdStr);
          
          logger.info('[research] run initialized', {
            mode: isQuick ? 'quick' : 'deep',
            piSessionId,
            researchId,
            selectedModelId: modelIdStr,
          });

          // Single master update function for this Pi session
          const updateMasterWidget = () => {
            const masterPanelCreator = createMasterResearchPanel(piSessionId);
            ctx.ui.setWidget(masterWidgetId, masterPanelCreator, { placement: 'aboveEditor' });
          };

          // Register this research run's state and the master update function
          registerSessionPanel(piSessionId, researchId, panelState);
          registerMasterUpdate(piSessionId, updateMasterWidget);
          
          // Subscribe to order changes to ensure refresh when ANY run starts/ends
          const unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

          // Robust functional health check before research starts
          await ensureFunctionalHealth(panelState, () => refreshAllSessions(piSessionId));

          const onTokens = (n: number) => {
            panelState.totalTokens += n;
            refreshAllSessions(piSessionId);
          };

          cleanup = () => {
            unsubOrder();
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
          signal?.addEventListener('abort', () => {
            aborted = true;
            logger.warn('[research] run aborted', { piSessionId, researchId });
            cleanup?.();
          }, { once: true });

          if (isQuick) {
            const sliceLabel = 'researching ...';
            addSlice(panelState, sliceLabel, sliceLabel, false);
            activateSlice(panelState, sliceLabel);
            // Quick mode: 1 researcher × 10 units (8 tool calls + 2-unit final-report step)
            panelState.progress = { expected: 10, made: 0, extended: false };
            refreshAllSessions(piSessionId);
            const researcherPromptRaw = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');
            const researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher');
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
              searxngUrl,
              extensionCtx: ctx,
              getTokensUsed: () => quickSessionTokens,
              contextWindowSize: quickContextWindowSize,
            });
            
            const calculateUsageCost = (usage: any): number => {
              if (!usage || !selectedModel?.cost) return 0;
              const modelCost = selectedModel.cost;
              const inputCost = (modelCost.input / 1_000_000) * (usage.input || 0);
              const outputCost = (modelCost.output / 1_000_000) * (usage.output || 0);
              const cacheReadCost = (modelCost.cacheRead / 1_000_000) * (usage.cacheRead || 0);
              const cacheWriteCost = (modelCost.cacheWrite / 1_000_000) * (usage.cacheWrite || 0);
              return inputCost + outputCost + cacheReadCost + cacheWriteCost;
            };

            const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
              if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const usage = event.message?.usage;
                if (usage) {
                  const cost = calculateUsageCost(usage);
                  const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
                  if (tokens > 0) {
                    quickSessionTokens += tokens; // drives context-aware scrape gating
                    onTokens(tokens);
                    updateSliceTokens(panelState, sliceLabel, tokens, cost);
                    refreshAllSessions(piSessionId);
                  }
                }
              } else if (event.type === 'tool_execution_end') {
                const isError = event.isError ?? false;
                const color = isError ? 'red' : 'green';
                const duration = isError ? 400 : 60;
                flashSlice(panelState, sliceLabel, color, duration, () => refreshAllSessions(piSessionId));
                // Advance progress bar
                if (panelState.progress) {
                  panelState.progress.made += 1;
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
            const exportPath = await exportResearchReport(sanitizedQuery, result, 'quick');
            const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

            // Cleanup subscription
            if (typeof subscription === 'function') {
              subscription();
            }

            completeSlice(panelState, sliceLabel);
            cleanup();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
          } else {
            // SWARM MODE: resolve complexity from explicit depth or LLM assessment.
            let complexity: 1 | 2 | 3;

            if (depth && depth !== 'brief') {
              // Explicit depth bypasses LLM assessment entirely.
              // brief=0 (Quick session, non-orchestrated)
              // normal=1 (1 round, 1-2 researchers)
              // deep=2   (2 rounds, 2-3 researchers)
              // ultra=3  (3 rounds, 3 researchers)
              const depthMap: Record<string, 1 | 2 | 3> = {
                normal: 1,
                deep:   2,
                ultra:  3,
              };
              complexity = depthMap[depth] ?? 2;
              logger.info('[research] depth override — skipping LLM complexity assessment', { depth, complexity });
            } else {
              // Auto-assess complexity via LLM (original behaviour).
              const complexityPrompt = `Analyze the research query: "${query}"
Rate complexity from 1 to 3:
1: Simple fact (1 researcher)
2: Standard topic (2 researchers)
3: Deep/Nuanced topic (3 researchers, more rounds)
Output ONLY the number 1, 2, or 3.`;

              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
              if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);
              const compResp = await complete(selectedModel, {
                messages: [{ role: 'user', content: [{ type: 'text', text: complexityPrompt }], timestamp: Date.now() }]
              }, { apiKey: auth.apiKey!, headers: auth.headers, signal });

              const rawComplexity = parseInt(compResp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim(), 10);
              complexity = (Number.isFinite(rawComplexity) ? Math.max(1, Math.min(3, rawComplexity)) : 2) as 1 | 2 | 3;
            }

            const orchestrator = new DeepResearchOrchestrator({
              ctx,
              model: selectedModel as Model<any>,
              query: sanitizedQuery,
              complexity,
              onTokens,
              onUpdate: () => refreshAllSessions(piSessionId),
              searxngUrl,
              panelState,
            });
            const result = await orchestrator.run(signal);

            // Snap to 100%
            if (panelState.progress) {
              panelState.progress.made = panelState.progress.expected;
              refreshAllSessions(piSessionId);
            }

            // Export research report
            const exportPath = await exportResearchReport(sanitizedQuery, result, 'deep');
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
