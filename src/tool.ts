/**
 * pi-research: Multi-Agent Research Orchestration Tool
 *
 * This is the primary entry point for the pi-research extension. It handles:
 * 1. Configuration validation and browser-based search engine lifecycle.
 * 2. TUI (Terminal UI) initialization and real-time progress tracking.
 * 3. Branching between "Quick" (single-agent) and "Deep" (multi-agent/multi-round) research modes.
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
} from './types/extension-context.ts';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { type Model, type Usage } from '@mariozechner/pi-ai';
import { Type } from 'typebox';
import { createResearcherSession } from "./orchestration/researcher.ts";
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
} from './tui/research-panel.ts';
import { ensureAssistantResponse } from './utils/text-utils.ts';
import { calculateTotalTokens } from './types/llm.ts';
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
import { runHealthCheck, isHealthCheckSuccessful } from './healthcheck/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Functional Health Check for Tool Start
 */
async function ensureFunctionalHealth(
  panelState: any, 
  onUpdate: () => void
): Promise<void> {
  // Optimization: If a health check already succeeded (or is in progress and then succeeds),
  // skip the TUI slice to avoid "repeated" health check indicators for every session.
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
      'SCRAPE PROTOCOL: Up to 2 batches (Batch 1: 4 URLs, Batch 2: 4 URLs). Batches skip automatically when context > 55%.',
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
    // Use custom shell for large research output to avoid flicker
    renderShell: 'self',
    // Normalize arguments before validation
    prepareArguments: (args: unknown) => {
      const rawArgs = args as Record<string, unknown>;
      const normalized: Record<string, unknown> = {
        query: rawArgs['query'] ?? '',
        model: rawArgs['model'],
      };

      // Handle depth - accept string or number
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
        normalized['depth'] = 0; // Default to quick mode
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
        let panelState: any = null;

        try {
          validateConfig();

          let selectedModel = baseModel;
          if (modelId) selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;

          const typedModel = selectedModel as ModelWithId;
          const modelIdStr = typedModel?.id || 'unknown';

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;

          cleanup = () => {
            if (cleanup === null) return; // guard against double-call
            cleanup = null;
            if (unsubOrder) unsubOrder();
            endResearchSession(piSessionId, researchId);
            cleanupSharedLinks(researchId);
            const activePanels = getPiActivePanels(piSessionId);
            if (activePanels.length === 0) ctx.ui.setWidget(masterWidgetId, undefined);
            else refreshAllSessions(piSessionId);

            // Restore built-in loader row
            if (typeof (ctx.ui as any).setWorkingVisible === 'function') {
                (ctx.ui as any).setWorkingVisible(true);
            }

            logger.info('[research] cleanup completed', { piSessionId, researchId });
          };

          panelState = createInitialPanelState(researchId, sanitizedQuery, modelIdStr);
          registerSessionPanel(piSessionId, researchId, panelState);
          
          let renderTimeout: NodeJS.Timeout | null = null;
          const debouncedRefresh = () => {
            if (renderTimeout) return;
            renderTimeout = setTimeout(() => {
              renderTimeout = null;
              refreshAllSessions(piSessionId);
            }, 50);
          };

          const updateMasterWidget = () => {
            const masterPanelCreator = createMasterResearchPanel(piSessionId, getPiActivePanels);
            ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => masterPanelCreator(_tui, theme), { placement: 'aboveEditor' });
          };
          registerMasterUpdate(piSessionId, updateMasterWidget);
          unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

          // Hide built-in loader row to avoid duplicate spinners
          if (typeof (ctx.ui as any).setWorkingVisible === 'function') {
            (ctx.ui as any).setWorkingVisible(false);
          }

          await ensureFunctionalHealth(panelState, debouncedRefresh);

          const onTokens = (n: number) => {
            panelState.totalTokens += n;
            debouncedRefresh();
          };

          const researchComplexity = depth ?? 0;
          const isQuick = researchComplexity === 0;

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
            updateSliceStatus(panelState, sliceLabel, 'Researching...');
            panelState.progress = { expected: 10, made: 0, extended: false };
            debouncedRefresh();

            const researcherPromptTemplate = readFileSync(join(__dirname, 'prompts', 'researcher.md'), 'utf-8');
            const quickEvidenceSection =
                '## Search\n' +
                'You have access to the `search` tool. You get EXACTLY ONE search call — make it count.\n' +
                'Submit **20–30 diverse, specific, and non-overlapping queries** covering every possible angle of the topic.\n' +
                'Each query must target a distinct piece of information. Avoid generic queries.\n' +
                'Your goal is to gather a high-fidelity pool of initial links.\n\n' +
                '## Scrape\n' +
                'After searching, you must scrape the best 10–12 sources using the `scrape` tool (2 rounds, up to 6 URLs each).\n' +
                'Prioritize primary sources and authoritative data.';
            let researcherPrompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
                .replace('{{goal}}', sanitizedQuery)
                .replace('{{evidence_section}}', quickEvidenceSection);
            
            const extendedCtx = ctx as ExtendedExtensionContext;
            let quickSessionTokens = 0;
            const quickContextWindowSize = (selectedModel as any)?.contextWindow ?? 200000;

            const session = await createResearcherSession({
              cwd: ctx.cwd,
              ctxModel: selectedModel,
              modelRegistry: ctx.modelRegistry,
              settingsManager: extendedCtx.settingsManager || (ctx as any).settingsManager!,
              systemPrompt: researcherPrompt,
              extensionCtx: ctx,
              onSearchProgress: (completed, total) => {
                updateSliceStatus(panelState, sliceLabel, `Searching: ${completed}/${total}...`);
                debouncedRefresh();
              },
              getTokensUsed: () => quickSessionTokens,
              contextWindowSize: quickContextWindowSize,
            });
            
            const subscription = session.subscribe((event: AgentSessionEvent) => {
              if (event.type === 'message_end') {
                const msg = event.message as any;
                if (msg?.role !== 'assistant') return;
                const rawUsage = msg.usage as Usage | undefined;
                const tokens = calculateTotalTokens(rawUsage ?? {});
                // Use pre-calculated cost from pi-ai provider
                const cost: number = rawUsage ? ((rawUsage as any).cost?.total ?? 0) : 0;
                if (tokens > 0) {
                  quickSessionTokens += tokens;
                  onTokens(tokens);
                  panelState.totalCost += cost;
                  updateSliceTokens(panelState, sliceLabel, tokens, cost);
                }
              } else if (event.type === 'tool_execution_end' && !event.isError) {
                if (panelState.progress) {
                  panelState.progress.made += 1;
                  debouncedRefresh();
                }
              } else if (event.type === 'tool_execution_start' && event.toolName === 'search') {
                panelState.isSearching = true;
                debouncedRefresh();
              } else if (event.type === 'tool_execution_end' && event.toolName === 'search') {
                panelState.isSearching = false;
                debouncedRefresh();
              }
            });

            try {
              if (signal) {
                await Promise.race([
                  session.prompt(sanitizedQuery),
                  new Promise<never>((_, reject) => {
                    if (signal.aborted) reject(new Error('Aborted'));
                    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
                  }),
                ]);
              } else {
                  await session.prompt(sanitizedQuery);
              }
              
              const result = ensureAssistantResponse(session, 'Quick');
              if (panelState.progress) panelState.progress.made = panelState.progress.expected;
              debouncedRefresh();

              const exportPath = await exportResearchReport(sanitizedQuery, result, 'quick', ctx.cwd);
              const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

              return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
            } finally {
              panelState.isSearching = false;
              if (typeof subscription === 'function') subscription();
              completeSlice(panelState, sliceLabel);
              cleanup?.();
            }
          } else {
            const orchestrator = new DeepResearchOrchestrator({
              ctx,
              model: selectedModel as Model<any>,
              query: sanitizedQuery,
              complexity: researchComplexity as 1|2|3,
              onTokens,
              onUpdate: debouncedRefresh,
              panelState,
            });

            const result = await orchestrator.run(signal);
            const exportPath = await exportResearchReport(sanitizedQuery, result, 'deep', ctx.cwd);
            const finalResult = exportPath ? appendExportMessage(result, exportPath) : result;

            cleanup?.();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
          }
        } catch (error) {
          if (aborted) return { content: [{ type: 'text', text: 'Research cancelled.' }], details: {} };
          
          cleanup?.();
          logger.error('[research] run failed', error);
          return { content: [{ type: 'text', text: `Research failed: ${String(error)}` }], details: {} };
        }
      });
    },
  };
}
