/**
 * Research Tool
 *
 * Main orchestration logic for research tool.
 * Creates coordinator session that naturally calls delegate_research and investigate_context tools.
 * Initializes SearXNG on first call (lazy initialization).
 *
 * Supports two TUI modes (configured via PI_RESEARCH_TUI_MODE):
 * - 'simple' (default): Compact 3-line display with SearXNG status + agent dots
 * - 'full': Boxed grid layout showing slice/depth hierarchy with visual research tree
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
import { createCoordinatorSession } from './coordinator.js';
import { TUI_MODE, validateConfig, logConfig, RESEARCHER_TIMEOUT_MS, FLASH_TIMEOUT_MS } from './config.js';
import {
  createPanel,
  getCapturedTui,
  clearAllFlashTimeouts,
  type PanelState,
  createInitialPanelState,
} from './tui/panel-factory.js';
import type { SimplePanelState, FullPanelState } from './tui/panel-factory.js';
import { formatParentContext } from './session-context.js';
import {
  initLifecycle,
  ensureRunning,
  getStatus,
  onStatusChange,
  type SearxngStatus,
} from './searxng-lifecycle.js';
import { getManager } from './searxng-lifecycle.js';
import { createDelegateTool, type DelegateToolOptions, type PanelState as DelegatePanelState } from './delegate-tool.js';
import { createInvestigateContextTool } from './context-tool.js';
import type { CreateResearcherSessionOptions } from './researcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function extractText(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

export function createResearchTool(): ToolDefinition {
  return {
    name: 'research',
    label: 'Research',
    description:
      'Orchestrate multi-agent research: coordinator delegates to parallel/sequential researchers, synthesizes findings. Uses web search, scraping, security databases, and code search.',
    promptSnippet: 'Conduct multi-agent research on a topic',
    promptGuidelines: [
      'Use research to investigate complex topics requiring multiple perspectives.',
      'The coordinator breaks down the query into research slices.',
      'Researchers investigate using web search, scraping, security databases, and code search.',
      'Results are synthesized into a final comprehensive answer.',
    ],
    parameters: Type.Object({
      query: Type.String({
        description: 'Research query or topic to investigate',
      }),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const query = (params as { query: string }).query;

      // 1. Validate
      if (!query) {
        return {
          content: [{ type: 'text', text: 'Error: query is required' }],
          details: {},
        };
      }

      if (!ctx.model) {
        return {
          content: [{ type: 'text', text: 'Error: No model selected. Please select a model before using the research tool.' }],
          details: {},
        };
      }

      // 2. Config
      try {
        validateConfig();
        logConfig();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('[research] Invalid configuration:', errorMsg);
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

      console.log(`[research] Starting research orchestration (TUI mode: ${TUI_MODE}):`, { query: query.slice(0, 50) });

      // 3. Init SearXNG
      try {
        await initLifecycle(ctx);
      } catch (error) {
        console.error('[research] Failed to initialize SearXNG:', error);
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

        // Register manager with pi-search-scrape
        try {
          const manager = getManager();
          if (manager) {
            const { setSearxngManager } = await import('../../pi-search-scrape/utils.ts');
            setSearxngManager(manager);
            console.debug('[research] Registered SearXNG manager with pi-search-scrape');
          }
        } catch (regError) {
          console.warn('[research] Could not register manager with pi-search-scrape:', regError instanceof Error ? regError.message : String(regError));
        }
      } catch (error) {
        console.error('[research] Failed to ensure SearXNG running:', error);
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

      // 4. Setup TUI
      const searxngStatus = getStatus();
      let panelState: PanelState;

      if (TUI_MODE === 'full') {
        panelState = createInitialPanelState(searxngStatus) as FullPanelState;
      } else {
        panelState = createInitialPanelState(searxngStatus) as SimplePanelState;
        // Update searxngStatus in simple mode
        (panelState as SimplePanelState).searxngStatus = searxngStatus;
      }

      ctx.ui.setWidget('pi-research-panel', createPanel(panelState), { placement: 'aboveEditor' });
      getCapturedTui()?.requestRender?.();

      // Subscribe to SearXNG status changes (simple mode only)
      const unsubStatus = onStatusChange((status: SearxngStatus) => {
        if (TUI_MODE === 'simple') {
          (panelState as SimplePanelState).searxngStatus = status;
        }
        getCapturedTui()?.requestRender?.();
      });

      // Cleanup function
      const cleanup = () => {
        console.log('[research] Cleaning up...');
        unsubStatus();
        clearAllFlashTimeouts();
        ctx.ui.setWidget('pi-research-panel', undefined);
      };

      signal?.addEventListener('abort', cleanup, { once: true });

      // 5. Mutable label state
      const breadthCounter = { value: 0 };

      // 6. Shared options for researcher creation
      const sessionManager = SessionManager.inMemory();
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
      const coordinatorPrompt = readFileSync(join(__dirname, '..', 'prompts', 'coordinator.md'), 'utf-8');
      const researcherPrompt = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');

      const researcherOptions: CreateResearcherSessionOptions = {
        cwd: ctx.cwd,
        ctxModel: ctx.model,
        modelRegistry: ctx.modelRegistry,
        sessionManager,
        settingsManager,
        systemPrompt: researcherPrompt,
        searxngUrl,
        extensionCtx: ctx,
      };

      // 7. Create tools for coordinator
      const onTokens = (n: number) => {
        panelState.totalTokens += n;
        getCapturedTui()?.requestRender?.();
      };

      const delegateToolOptions: DelegateToolOptions = {
        breadthCounter,
        panelState: panelState as DelegatePanelState,
        onTokens,
        researcherOptions,
        signal,
        timeoutMs: RESEARCHER_TIMEOUT_MS,
        flashTimeoutMs: FLASH_TIMEOUT_MS,
      };

      const delegateTool = createDelegateTool(delegateToolOptions);
      const contextTool = createInvestigateContextTool({
        cwd: ctx.cwd,
        ctxModel: ctx.model,
        modelRegistry: ctx.modelRegistry,
      });

      // 8. Create coordinator session
      const coordinatorSession = await createCoordinatorSession({
        cwd: ctx.cwd,
        ctxModel: ctx.model,
        modelRegistry: ctx.modelRegistry,
        sessionManager,
        settingsManager,
        systemPrompt: coordinatorPrompt,
        searxngUrl,
        extensionCtx: ctx,
        customTools: [delegateTool, contextTool],
      });

      // 9. Token tracking for coordinator itself
      coordinatorSession.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const tokens = (event.message as any).usage?.totalTokens;
          if (tokens) onTokens(tokens);
        }
      });

      // 10. Single prompt — coordinator converges on its own
      try {
        const context = formatParentContext(ctx);
        await coordinatorSession.prompt(`Context:\n${context}\n\nQuery: ${query}`);

        const msgs = coordinatorSession.messages;
        const last = [...msgs].reverse().find((m) => m.role === 'assistant');
        const text = extractText(last) || 'No answer synthesized.';

        cleanup();
        return { content: [{ type: 'text', text }], details: { totalTokens: panelState.totalTokens } };
      } catch (error) {
        cleanup();
        return {
          content: [
            {
              type: 'text',
              text: `Research failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: {},
        };
      }
    },
  };
}
