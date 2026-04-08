/**
 * Research Tool
 *
 * Main orchestration logic for research tool.
 * Orchestrates a state-driven swarm of researcher agents.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
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
import { SwarmOrchestrator } from './orchestration/swarm-orchestrator.ts';
import { createResearchRunId, logger, runWithLogContext } from './logger.ts';
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
  const sessionManager = (ctx as any).sessionManager;
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
      'Perform deep web/internet research using a state-driven swarm of agents. Synthesizes findings from web search, scraping, security databases, and Stack Exchange.',
    promptSnippet: 'Conduct multi-agent web/internet research',
    promptGuidelines: [
      'Specifically for web research, not local project exploration.',
      'Research is organized into Rounds. Each round contains multiple parallel siblings.',
      'SCRAPE PROTOCOL: Call the `scrape` tool TWICE per agent. First call retrieves links already scraped globally; second call performs your filtered scrape.',
      'The last sibling in each round evaluates progress and decides whether to continue or synthesize.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
      quick: Type.Optional(Type.Boolean({
        description: 'Enable quick mode: fast investigation using a single researcher session.',
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
      const { query, model: modelId, quick: isQuick = false } = params as { query: string; quick?: boolean; model?: string };

      if (!query || !ctx.model) {
        return { content: [{ type: 'text', text: 'Error: query and model are required' }], details: {} };
      }

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

          const researchId = startResearchSession(piSessionId);
          const masterWidgetId = `pi-research-master-${piSessionId}`;
          const panelState = createInitialPanelState(researchId, query, getStatus(), (selectedModel as any)?.id || 'unknown');
          
          logger.info('[research] run initialized', {
            mode: isQuick ? 'quick' : 'swarm',
            piSessionId,
            researchId,
            selectedModelId: (selectedModel as any)?.id || 'unknown',
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
            refreshAllSessions(piSessionId);
            const researcherPromptRaw = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');
            const researcherPrompt = injectCurrentDate(researcherPromptRaw, 'researcher');
            const session = await createResearcherSession({
              cwd: ctx.cwd,
              ctxModel: selectedModel,
              modelRegistry: ctx.modelRegistry,
              settingsManager: (ctx as any).settingsManager,
              systemPrompt: researcherPrompt,
              searxngUrl,
              extensionCtx: ctx,
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

            const subscription = session.subscribe(event => {
              if (event.type === 'message_end' && event.message.role === 'assistant') {
                const usage = (event.message as any).usage;
                if (usage) {
                  const cost = calculateUsageCost(usage);
                  const tokens = usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
                  if (tokens > 0) {
                    onTokens(tokens);
                    updateSliceTokens(panelState, sliceLabel, tokens, cost);
                    refreshAllSessions(piSessionId);
                  }
                }
              } else if (event.type === 'tool_execution_end') {
                const color = (event as any).isError ? 'red' : 'green';
                const duration = (event as any).isError ? 400 : 60;
                flashSlice(panelState, sliceLabel, color, duration, () => refreshAllSessions(piSessionId));
              }
            });

            await session.prompt(query);
            const result = ensureAssistantResponse(session, 'Quick');
            
            // Cleanup subscription
            subscription();

            completeSlice(panelState, sliceLabel);
            cleanup();
            return { content: [{ type: 'text', text: result }], details: { totalTokens: panelState.totalTokens } };
          } else {
            // SWARM MODE: Start with complexity assessment
            const complexityPrompt = `Analyze the research query: "${query}"
Rate complexity from 1 to 3:
1: Simple fact (1 researcher)
2: Standard topic (3 researchers)
3: Deep/Nuanced topic (3 researchers, more rounds)
Output ONLY the number 1, 2, or 3.`;

            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel);
            if (!auth.ok) throw new Error(`Failed to get API credentials: ${auth.error}`);
            const compResp = await complete(selectedModel, {
              messages: [{ role: 'user', content: [{ type: 'text', text: complexityPrompt }], timestamp: Date.now() }]
            }, { apiKey: auth.apiKey!, headers: auth.headers, signal });
            
            const complexity = parseInt(compResp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim(), 10) || 2;

            const orchestrator = new SwarmOrchestrator({
              ctx,
              model: selectedModel as any,
              query,
              complexity: complexity as 1 | 2 | 3,
              onTokens,
              onUpdate: () => refreshAllSessions(piSessionId),
              searxngUrl,
              panelState,
              });
            const result = await orchestrator.run(signal);
            cleanup();
            return { content: [{ type: 'text', text: result }], details: { totalTokens: panelState.totalTokens } };
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
