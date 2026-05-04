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
  MAX_GATHERING_CALLS, 
  getMaxScrapeBatches,
  UNITS_PER_RESEARCHER,
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
                
                const maxScrapeBatches = getMaxScrapeBatches();
                const expectedTools = Math.max(1, MAX_GATHERING_CALLS + maxScrapeBatches - 3);
                panelState.progress = { expected: expectedTools, made: 0 };
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
              const count = plan.researchers?.length || 0;
              const units = (count * UNITS_PER_RESEARCHER) + LEAD_EVAL_UNITS;
              panelState.progress = { expected: units, made: 0 };
              debouncedRefresh();
            },
            onSearchStart: () => {
              const sliceId = panelState.slices.has('coord') && !panelState.slices.get('coord')?.completed ? 'coord' : (quickSliceLabel || 'eval');
              if (sliceId === 'eval' && panelState.slices.has('eval')) reactivateSlice(panelState, 'eval');
              updateSliceStatus(panelState, sliceId, '0 Results');
              panelState.isSearching = true;
              debouncedRefresh();
            },
            onSearchProgress: (count) => {
              const sliceId = panelState.slices.has('coord') && !panelState.slices.get('coord')?.completed ? 'coord' : (quickSliceLabel || 'eval');
              updateSliceStatus(panelState, sliceId, `${count} Results`);
              debouncedRefresh();
            },
            onSearchComplete: () => {
              panelState.isSearching = false;
              if (panelState.slices.has('coord') && !panelState.slices.get('coord')?.completed) {
                completeSlice(panelState, 'coord');
                panelState.slices.delete('coord');
              }
              debouncedRefresh();
            },
            onResearcherStart: (id) => {
              const displayNum = id.replace(/^r/, '');
              addSlice(panelState, displayNum, displayNum, true);
              activateSlice(panelState, displayNum);
              debouncedRefresh();
            },
            onResearcherProgress: (id, status, tokens, cost) => {
              const displayNum = id === 'quick' ? quickSliceLabel : id.replace(/^r/, '');
              if (status !== undefined) {
                updateSliceStatus(panelState, displayNum, status || undefined);
                if (!status && panelState.progress) {
                  const current = progressCredits.get(id) ?? 0;
                  if (current + 1 <= UNITS_PER_RESEARCHER) {
                    panelState.progress.made += 1;
                    progressCredits.set(id, current + 1);
                  }
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
                const current = progressCredits.get(id) ?? 0;
                const remaining = UNITS_PER_RESEARCHER - current;
                if (remaining > 0) {
                  panelState.progress.made += remaining;
                  progressCredits.set(id, UNITS_PER_RESEARCHER);
                }
              }
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
            onEvaluationDecision: (action, plan) => {
              completeSlice(panelState, 'eval');
              if (panelState.progress) {
                const key = `eval.${panelState.slices.size}`;
                if (!progressCredits.has(key)) {
                  panelState.progress.made += LEAD_EVAL_UNITS;
                  progressCredits.set(key, LEAD_EVAL_UNITS);
                }
              }
              if (action === 'synthesize') {
                if (panelState.progress) panelState.progress.made = panelState.progress.expected;
                setTimeout(() => { clearCompletedResearchers(panelState); debouncedRefresh(); }, 500);
              } else {
                const toRemove: string[] = [];
                for (const [sid, slice] of panelState.slices.entries()) {
                  if (slice.completed && sid !== 'eval') toRemove.push(sid);
                }
                for (const sid of toRemove) panelState.slices.delete(sid);
                if (plan?.researchers && plan.researchers.length > 0 && panelState.progress) {
                  panelState.progress.expected += (plan.researchers.length * UNITS_PER_RESEARCHER) + LEAD_EVAL_UNITS;
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
          const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

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
