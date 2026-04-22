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
  ExtendedAgentSessionEvent,
} from './types/extension-context.ts';
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
import { parseTokenUsage, calculateTotalTokens } from './types/llm.ts';
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
    description: 'Perform deep research using a coordinated team of agents. Synthesizes search, scrape, security, and Stack Exchange data.',
    promptSnippet: 'Conduct multi-agent web research',
    promptGuidelines: [
      'Specifically for web research.',
      'Research is organized into Rounds with parallel siblings.',
      'SCRAPE PROTOCOL: Up to 3 batches (Batch 1: 3 URLs, Batch 2: 2 URLs, Batch 3: 3 URLs). Batches skip if context is full.',
      'Steering messages provide real-time evidence updates from siblings.',
      '`security_search` and `stackexchange` are available for specialized data.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Research topic' }),
      depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: 'Complexity level (0-3).' })),
      model: Type.Optional(Type.String({ description: 'Model ID' })),
    }),
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

        try {
          validateConfig();

          let selectedModel = baseModel;
          if (modelId) selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || baseModel;

          const typedModel = selectedModel as ModelWithId;
          const modelIdStr = typedModel?.id || 'unknown';

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;

          cleanup = () => {
            if (unsubOrder) unsubOrder();
            endResearchSession(piSessionId, researchId);
            cleanupSharedLinks(researchId);
            clearAllFlashTimeouts(researchId);
            const activePanels = getPiActivePanels(piSessionId);
            if (activePanels.length === 0) ctx.ui.setWidget(masterWidgetId, undefined);
            else refreshAllSessions(piSessionId);
            logger.info('[research] cleanup completed', { piSessionId, researchId });
          };

          const panelState = createInitialPanelState(researchId, sanitizedQuery, modelIdStr);
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
            ctx.ui.setWidget(masterWidgetId, (_tui: any, theme: any) => masterPanelCreator(theme), { placement: 'aboveEditor' });
          };
          registerMasterUpdate(piSessionId, updateMasterWidget);
          unsubOrder = onSessionOrderChange(piSessionId, () => refreshAllSessions(piSessionId));

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
            panelState.progress = { expected: 4, made: 0, extended: false };
            debouncedRefresh();

            const researcherPromptTemplate = readFileSync(join(__dirname, 'prompts', 'researcher.md'), 'utf-8');
            let researcherPrompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
                .replace('{{goal}}', sanitizedQuery)
                .replace('{{evidence_section}}', '');
            
            researcherPrompt += '\n\n## Quick Mode Efficiency\nConcise report for definitive fact-finding.';
            
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
              getTokensUsed: () => quickSessionTokens,
              contextWindowSize: quickContextWindowSize,
            });
            
            const subscription = session.subscribe((event: ExtendedAgentSessionEvent) => {
              if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const usage = parseTokenUsage(event.message?.usage);
                const tokens = calculateTotalTokens(usage);
                if (tokens > 0) {
                  quickSessionTokens += tokens;
                  onTokens(tokens);
                  updateSliceTokens(panelState, sliceLabel, tokens, 0);
                }
              } else if (event.type === 'tool_execution_end') {
                const color = event.isError ? 'red' : 'green';
                flashSlice(panelState, sliceLabel, color, 500, debouncedRefresh);
                if (panelState.progress && !event.details?.blocked) {
                  panelState.progress.made += 1;
                  debouncedRefresh();
                }
              }
            });

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

            if (typeof subscription === 'function') subscription();
            completeSlice(panelState, sliceLabel);
            cleanup();
            return { content: [{ type: 'text', text: finalResult }], details: { totalTokens: panelState.totalTokens } };
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

            cleanup();
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
