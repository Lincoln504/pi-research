/**
 * pi-research: Multi-Agent Research Orchestration Tool
 *
 * This is the primary entry point for the pi-research extension. It handles:
 * 1. Configuration validation and browser-based search engine lifecycle.
 * 2. TUI (Terminal UI) initialization and real-time progress tracking.
 * 3. Unified execution of "Quick" and "Deep" research modes via ResearchManager.
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import type {
  ExtendedExtensionContext,
  SessionManager,
  ModelWithId,
} from './types/extension-context.ts';
import { type Model } from '@mariozechner/pi-ai';
import { Type } from 'typebox';
import { validateConfig } from './config.ts';
import {
  createMasterResearchPanel,
  addSlice,
  activateSlice,
  completeSlice,
  removeSlice,
  updateSliceTokens,
  updateSliceStatus,
  createInitialPanelState,
  reactivateSlice,
  clearCompletedResearchers,
} from './tui/research-panel.ts';
import { runResearch } from './orchestration/research-manager.ts';
import { type ResearchObserver } from './orchestration/research-observer.ts';
import { createResearchRunId, logger, runWithLogContext } from './logger.ts';
import { exportResearchReport, appendExportMessage } from './utils/research-export.ts';
import { validateAndSanitizeQuery } from './utils/input-validation.ts';
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
import { runHealthCheck, isHealthCheckSuccessful } from './healthcheck/index.ts';
import { 
  getUnitsPerResearcher,
  LEAD_EVAL_UNITS 
} from './constants.ts';

/**
 * Functional Health Check for Tool Start
 */
async function ensureFunctionalHealth(
  panelState: any, 
  onUpdate: () => void
): Promise<void> {
  if (await isHealthCheckSuccessful()) {
    return;
  }

  const sliceLabel = 'health check ...';
  addSlice(panelState, sliceLabel, sliceLabel, false);
  activateSlice(panelState, sliceLabel);
  onUpdate();

  try {
    const health = await runHealthCheck();
    if (!health.success) {
      throw new Error(`Functional health check failed: ${health.error || 'Unknown error'}.`);
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
      'Perform web/internet research using a coordinated team of agents. Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct multi-agent web/internet research',
    promptGuidelines: [
      'Specifically for web research, not local project exploration.',
      'Research is organized into Rounds. Each round contains multiple parallel siblings.',
      'SCRAPE PROTOCOL: Configurable batches (1-16 or unlimited, 4 URLs per batch). Set via /research-config.',
      'After each round, a Lead Evaluator assesses all findings and decides whether to delegate further or synthesize.',
      'Use `security_search` for vulnerabilities, CVE IDs, package security, or actively exploited vulnerabilities.',
      'Use `stackexchange` for technical questions, code solutions, debugging help, and best practices.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      depth: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 3,
        description: [
          'Research complexity 0-3.',
          '0=Quick — single direct session. Simple facts, lookups. ~85% of queries.',
          '1=Normal — up to 2 siblings per round, up to 2 rounds.',
          '2=Deep — up to 3 siblings per round, up to 3 rounds.',
          '3=Ultra — up to 5 siblings per round, up to 5 rounds. Very expensive.',
          'Team size is flexible — the coordinator plans as many as needed (up to the max).',
          '"deep" → depth 2, NOT 3. depth 3 only for "ultra"/"exhaustive"/"comprehensive"/"deep-dive".',
        ].join(' '),
      })),
      model: Type.Optional(Type.String({
        description: 'Model ID to use for all research agents (defaults to current active model)',
      })),
    }),
    renderShell: 'self',
    prepareArguments: (args: unknown) => {
      const rawArgs = args as Record<string, unknown>;
      const normalized: Record<string, unknown> = {
        query: rawArgs['query'] ?? '',
        model: rawArgs['model'],
      };

      const rawDepth = rawArgs['depth'];
      if (rawDepth !== undefined && rawDepth !== null) {
        if (typeof rawDepth === 'string') {
          const parsed = parseInt(rawDepth, 10);
          normalized['depth'] = isNaN(parsed) ? 0 : Math.max(0, Math.min(3, parsed));
        } else if (typeof rawDepth === 'number') {
          normalized['depth'] = Math.max(0, Math.min(3, rawDepth));
        } else {
          normalized['depth'] = 0;
        }
      } else {
        normalized['depth'] = 0;
      }

      return normalized;
    },
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const { query, model: modelId, depth } = params as { query: string; depth?: number; model?: string; };

      if (!query || !ctx.model) {
        return { content: [{ type: 'text', text: 'Error: query and model are required' }], details: {} };
      }

      const sanitizedQuery = validateAndSanitizeQuery(query);
      const baseModel = ctx.model;
      const researchRunId = createResearchRunId();
      const metadata = getPiSessionMetadata(ctx);
      const piSessionId = metadata.piSessionId;

      return runWithLogContext({ ...metadata, researchRunId, toolName: 'research' }, async () => {
        let aborted = false;
        let cleanup: (() => void) | null = null;
        let unsubOrder: (() => void) | null = null;
        let unsubInput: (() => void) | null = null;
        let panelState: any = null;

        const internalAbort = new AbortController();

        try {
          validateConfig();

          let selectedModel = baseModel;
          if (modelId) selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;

          const typedModel = selectedModel as ModelWithId;
          const modelIdStr = typedModel?.id || 'unknown';

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;

          cleanup = () => {
            if (cleanup === null) return;
            cleanup = null;
            if (unsubOrder) unsubOrder();
            if (unsubInput) { unsubInput(); unsubInput = null; }
            endResearchSession(piSessionId, researchId);
            cleanupSharedLinks(researchId);
            const activePanels = getPiActivePanels(piSessionId);
            if (activePanels.length === 0) ctx.ui.setWidget(masterWidgetId, undefined);
            else refreshAllSessions(piSessionId);

            if (typeof (ctx.ui as any).setWorkingVisible === 'function') {
                (ctx.ui as any).setWorkingVisible(true);
            }

            logger.info('[research] cleanup completed', { piSessionId, researchId });
          };

          panelState = createInitialPanelState(researchId, sanitizedQuery, modelIdStr);
          registerSessionPanel(piSessionId, researchId, panelState);

          const debouncedRefresh = () => refreshAllSessions(piSessionId);

          const updateMasterWidget = () => {
            const masterPanelCreator = createMasterResearchPanel(piSessionId, getPiActivePanels);
            ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => masterPanelCreator(_tui, theme), { placement: 'aboveEditor' });
          };
          registerMasterUpdate(piSessionId, updateMasterWidget);
          unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

          if (typeof (ctx.ui as any).setWorkingVisible === 'function') {
            (ctx.ui as any).setWorkingVisible(false);
          }

          await ensureFunctionalHealth(panelState, debouncedRefresh);

          signal?.addEventListener('abort', () => {
            aborted = true;
            internalAbort.abort();
            cleanup?.();
          }, { once: true });

          unsubInput = ctx.ui.onTerminalInput((data: string) => {
            if (data !== '\x1b' && data !== '\x03') return undefined;
            internalAbort.abort();
            return { consume: true };
          });

          const researchComplexity = depth ?? 0;
          const progressCredits = new Map<string, number>();
          let quickSliceLabel = '';

          const observer: ResearchObserver = {
            onStart: (query, complexity) => {
              if (complexity === 0) {
                const truncatedQuery = query.length > 20 ? query.slice(0, 20) + '...' : query;
                quickSliceLabel = `researching: ${truncatedQuery}`;
                addSlice(panelState, quickSliceLabel, quickSliceLabel, false);
                activateSlice(panelState, quickSliceLabel);
                updateSliceStatus(panelState, quickSliceLabel, 'Researching...');
                
                const units = getUnitsPerResearcher();
                panelState.progress = { expected: units, made: 0 };
              }
              debouncedRefresh();
            },
            onPlanningStart: (attempt) => {
              if (attempt === 1) {
                addSlice(panelState, 'coord', `coordinator`, false);
                activateSlice(panelState, 'coord');
              }
              updateSliceStatus(panelState, 'coord', attempt > 1 ? `Planning (retry ${attempt-1})...` : 'Planning...');
              debouncedRefresh();
            },
            onPlanningProgress: (status) => {
              updateSliceStatus(panelState, 'coord', status);
              debouncedRefresh();
            },
            onPlanningTokens: (tokens, cost) => {
              panelState.totalCost += cost;
              updateSliceTokens(panelState, 'coord', tokens, cost);
              panelState.totalTokens += tokens;
              debouncedRefresh();
            },
            onPlanningSuccess: (plan) => {
              completeSlice(panelState, 'coord');
              const unitsPerResearcher = getUnitsPerResearcher();
              const count = plan.researchers?.length || 0;
              const units = (count * unitsPerResearcher) + LEAD_EVAL_UNITS;
              panelState.progress = { expected: units, made: 0 };
              debouncedRefresh();
            },
            onRoundStart: (round) => {
              // Clear researchers from previous rounds when starting a new round
              if (round > 1) {
                clearCompletedResearchers(panelState);
              }
            },
            onSearchStart: () => {
              let sliceId = 'coord';
              if (!panelState.slices.has('coord') && !quickSliceLabel) {
                 sliceId = 'eval';
                 if (!panelState.slices.has('eval')) {
                    addSlice(panelState, 'eval', 'eval', false);
                 }
              } else if (quickSliceLabel) {
                 sliceId = quickSliceLabel;
              }
              if (panelState.slices.has(sliceId)) reactivateSlice(panelState, sliceId);
              updateSliceStatus(panelState, sliceId, '0 Results');
              panelState.isSearching = true;
              debouncedRefresh();
            },
            onSearchProgress: (count) => {
              let sliceId = 'coord';
              if (!panelState.slices.has('coord') && !quickSliceLabel) {
                  sliceId = 'eval';
              } else if (quickSliceLabel) {
                  sliceId = quickSliceLabel;
              }
              updateSliceStatus(panelState, sliceId, `${count} Results`);
              debouncedRefresh();
            },
            onSearchComplete: () => {
              panelState.isSearching = false;
              if (panelState.slices.has('coord')) {
                completeSlice(panelState, 'coord');
              } else if (!quickSliceLabel && panelState.slices.has('eval')) {
                // Search burst for next round used eval slice
                completeSlice(panelState, 'eval');
              }
              debouncedRefresh();
            },
            onResearcherStart: (id, _name, _goal, _roundNumber) => {
              if (panelState.slices.get('coord')?.completed) removeSlice(panelState, 'coord');
              if (panelState.slices.get('eval')?.completed) removeSlice(panelState, 'eval');
              // Researchers from previous rounds are cleared in onRoundStart
              const displayNum = id === 'quick' ? quickSliceLabel : id.replace(/^r/, '');
              addSlice(panelState, displayNum, displayNum, true);
              activateSlice(panelState, displayNum);
              debouncedRefresh();
            },
            onResearcherProgress: (id, status, tokens, cost) => {
              const displayNum = id === 'quick' ? quickSliceLabel : id.replace(/^r/, '');
              const unitsPerResearcher = getUnitsPerResearcher();
              
              if (status !== undefined) {
                if (status.startsWith('done:')) {
                    const toolName = status.slice(5);
                    updateSliceStatus(panelState, displayNum, undefined);
                    if (panelState.progress) {
                        const current = progressCredits.get(id) ?? 0;
                        // Increment for the first tool call (setup/search) OR any scrape batch
                        const shouldIncrement = (current === 0) || (toolName === 'scrape');
                        if (shouldIncrement && current + 1 <= unitsPerResearcher) {
                            panelState.progress.made += 1;
                            progressCredits.set(id, current + 1);
                        }
                    }
                } else if (status) {
                    updateSliceStatus(panelState, displayNum, status);
                } else {
                    updateSliceStatus(panelState, displayNum, undefined);
                }
              }
              if (tokens !== undefined && cost !== undefined) {
                panelState.totalCost += cost;
                updateSliceTokens(panelState, displayNum, tokens, cost);
                panelState.totalTokens += tokens;
              }
              debouncedRefresh();
            },
            onResearcherComplete: (id) => {
              const displayNum = id === 'quick' ? quickSliceLabel : id.replace(/^r/, '');
              if (panelState.progress) {
                const unitsPerResearcher = getUnitsPerResearcher();
                const current = progressCredits.get(id) ?? 0;
                const remaining = unitsPerResearcher - current;
                if (remaining > 0) {
                  panelState.progress.made += remaining;
                  progressCredits.set(id, unitsPerResearcher);
                }
              }
              completeSlice(panelState, displayNum);
              debouncedRefresh();
            },
            onResearcherFailure: (id) => {
              const displayNum = id === 'quick' ? quickSliceLabel : id.replace(/^r/, '');
              if (panelState.progress) {
                const unitsPerResearcher = getUnitsPerResearcher();
                const current = progressCredits.get(id) ?? 0;
                const remaining = unitsPerResearcher - current;
                if (remaining > 0) {
                  panelState.progress.made += remaining;
                  progressCredits.set(id, unitsPerResearcher);
                }
              }
              updateSliceStatus(panelState, displayNum, 'Failed');
              completeSlice(panelState, displayNum);
              debouncedRefresh();
            },
            onEvaluationStart: () => {
              addSlice(panelState, 'eval', 'eval', false);
              activateSlice(panelState, 'eval');
              updateSliceStatus(panelState, 'eval', 'Assessing...');
              debouncedRefresh();
            },
            onEvaluationProgress: (status) => {
              updateSliceStatus(panelState, 'eval', status);
              debouncedRefresh();
            },
            onEvaluationTokens: (tokens, cost) => {
              panelState.totalCost += cost;
              updateSliceTokens(panelState, 'eval', tokens, cost);
              panelState.totalTokens += tokens;
              debouncedRefresh();
            },
            onEvaluationDecision: (action, plan, round) => {
              completeSlice(panelState, 'eval');
              // Only clear completed researchers when returning final synthesis
              // On delegation, researchers stay visible while new round researchers are added
              if (action === 'synthesize') {
                clearCompletedResearchers(panelState);
              }
              if (panelState.progress) {
                const key = `eval.round.${round ?? panelState.slices.size}`;
                if (!progressCredits.has(key)) {
                  panelState.progress.made += LEAD_EVAL_UNITS;
                  progressCredits.set(key, LEAD_EVAL_UNITS);
                }
              }
              if (action === 'synthesize') {
                if (panelState.progress) panelState.progress.made = panelState.progress.expected;
              } else {
                // Delegation: prepare for new round's researchers
                if (plan?.researchers && plan.researchers.length > 0 && panelState.progress) {
                  const unitsPerResearcher = getUnitsPerResearcher();
                  panelState.progress.expected += (plan.researchers.length * unitsPerResearcher) + LEAD_EVAL_UNITS;
                }
              }
              debouncedRefresh();
            },
            onComplete: () => {
              if (panelState.progress) panelState.progress.made = panelState.progress.expected;
              debouncedRefresh();
            },
            onError: () => {
              if (panelState.progress) panelState.progress.made = panelState.progress.expected;
              debouncedRefresh();
            }
          };

          const result = await runResearch({
            ctx,
            query: sanitizedQuery,
            depth: researchComplexity as any,
            model: selectedModel as Model<any>,
            observer,
            sessionId: piSessionId,
            researchId,
          }, internalAbort.signal);

          const exportPath = await exportResearchReport(sanitizedQuery, result, researchComplexity === 0 ? 'quick' : 'deep', ctx.cwd);
          const finalResult = exportPath ? appendExportMessage(result, exportPath, panelState.totalCost) : result;

          cleanup?.();
          return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };

        } catch (error) {
          if (aborted || internalAbort.signal.aborted) {
            cleanup?.();
            return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
          }
          cleanup?.();
          logger.error('[research] run failed', error);
          return { content: [{ type: 'text', text: `Research failed: ${String(error)}` }], details: {} };
        }
      });
    },
  };
}
