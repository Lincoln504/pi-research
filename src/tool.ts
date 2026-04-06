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
  AgentSessionEvent,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { complete } from '@mariozechner/pi-ai';
import { createResearcherSession } from "./orchestration/researcher.ts";
import { validateConfig, getConfig } from './config.ts';
import {
  createResearchPanel,
  clearAllFlashTimeouts,
  addSlice,
  activateSlice,
  completeSlice,
  removeSlice,
  createInitialPanelState,
} from './tui/research-panel.ts';
import { ensureAssistantResponse } from './utils/text-utils.ts';
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
import { SwarmOrchestrator } from './orchestration/swarm-orchestrator.ts';
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
      const restoreConsole = suppressConsole();

      if (!query || !ctx.model) {
        restoreConsole();
        return { content: [{ type: 'text', text: 'Error: query and model are required' }], details: {} };
      }

      try {
        validateConfig();
        await initLifecycle(ctx);
        const searxngUrl = await ensureRunning();
        const manager = getManager();
        if (manager) {
          const { setSearxngManager } = await import('./web-research/utils.ts');
          setSearxngManager(manager);
        }

        let selectedModel = ctx.model;
        if (modelId) {
          selectedModel = ctx.modelRegistry.getAll().find(m => m.id === modelId) || ctx.model;
        }

        const sessionId = startResearchSession();
        const widgetId = `pi-research-panel-${sessionId}`;
        const panelState = createInitialPanelState(sessionId, getStatus(), (selectedModel as any)?.id || 'unknown');

        const updateWidget = () => {
          panelState.hideSearxng = !isBottomMostSession(sessionId);
          ctx.ui.setWidget(widgetId, createResearchPanel(panelState), { placement: 'aboveEditor' });
        };
        registerSessionUpdate(sessionId, updateWidget);

        const onTokens = (n: number) => {
          panelState.totalTokens += n;
          refreshAllSessions();
        };

        const cleanup = () => {
          endResearchSession(sessionId);
          cleanupSharedLinks(sessionId);
          ctx.ui.setWidget(widgetId, undefined);
          refreshAllSessions();
          setTimeout(restoreConsole, getConfig().CONSOLE_RESTORE_DELAY_MS).unref?.();
        };
        signal?.addEventListener('abort', cleanup, { once: true });

        if (isQuick) {
          const sliceLabel = 'researching ...';
          addSlice(panelState, sliceLabel, sliceLabel, false);
          activateSlice(panelState, sliceLabel);
          updateWidget();

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
          
          session.subscribe(event => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
              onTokens((event.message as any).usage?.totalTokens || 0);
            }
          });

          await session.prompt(query);
          const result = ensureAssistantResponse(session, 'Quick');
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
          const compResp = await complete(selectedModel, {
            messages: [{ role: 'user', content: [{ type: 'text', text: complexityPrompt }], timestamp: Date.now() }]
          }, { apiKey: auth.apiKey!, headers: auth.headers, signal });
          
          const complexity = parseInt(compResp.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').trim(), 10) || 2;

          const orchestrator = new SwarmOrchestrator({
            ctx,
            query,
            complexity: complexity as 1 | 2 | 3,
            onTokens,
            onUpdate: updateWidget,
            searxngUrl,
            panelState,
          });

          const result = await orchestrator.run(signal);
          cleanup();
          return { content: [{ type: 'text', text: result }], details: { totalTokens: panelState.totalTokens } };
        }
      } catch (error) {
        restoreConsole();
        return { content: [{ type: 'text', text: `Research failed: ${error}` }], details: {} };
      }
    },
  };
}
