/**
 * Quick Research Orchestrator
 *
 * Implements the single-agent research loop.
 * Optimized for speed and efficiency for simple queries.
 */

import { 
    type ExtensionContext, 
    type AgentSessionEvent,
    type AgentToolResult
} from '@earendil-works/pi-coding-agent';
import { type Model, calculateCost } from '@earendil-works/pi-ai';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { createResearcherSession } from './researcher.ts';
import { ensureAssistantResponse, parseCitations } from '../utils/text-utils.ts';
import { getMaxScrapeBatches } from '../constants.ts';
import type { ResearchObserver } from './research-observer.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IWriterQueue, IKnowledgeStoreService } from '../core/service-interfaces.ts';
import { normalizeUrl, registerScrapedLinks, getCachedScrapedContent } from '../utils/shared-links.ts';
import { runHealthCheck } from '../healthcheck/index.ts';
import { metrics } from '../utils/metrics.ts';
import type { AbortCleanup, ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import {
  cleanupResearchServices,
} from './research-session-manager.ts';

export interface QuickResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  onUpdate?: (update: AgentToolResult<any>) => void;
  config?: Config;
  excludeTools?: string[];
}

export class QuickResearchOrchestrator {
  private config: Config;

  constructor(private options: QuickResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
  }

  async run(signal?: AbortSignal): Promise<string> {
    const { query, model, ctx, observer, researchId } = this.options;
    const sessionStart = Date.now();
    logger.log(`[QuickOrchestrator] Starting research: "${query}"`);
    observer?.onStart?.(query, 0);
    metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0' });

    try {
        // Pre-flight health check to ensure browser pool is operational
        const health = await runHealthCheck();
        if (!health.success) {
          const error = health.error || 'Unknown health check failure';
          logger.error(`[QuickOrchestrator] Health check failed: ${error}`);
          metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'health_check_failed' });
          throw new Error(`Research cannot start: ${error}`);
        }

        // Knowledge Store Context Injection
        let storeSection = '';
        if (this.config.KNOWLEDGE_STORE_ENABLED) {
          try {
            const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
            if (!ksService.isReady()) {
                logger.debug('[QuickOrchestrator] Knowledge store service not ready');
            } else {
              const store = await ksService.getStore();
              if (store && typeof store.findRelevantUrls === 'function') {
                const historicalEntries = await store.findRelevantUrls(query, { limit: 5 });
                if (historicalEntries.length > 0) {
                  storeSection = '\n## Historical Knowledge Store (Discovery)\n' +
                    'The following URLs were found in your local knowledge store from previous research sessions. ' +
                    'Scrape them to retrieve their full current content. Each summary describes what was previously found:\n' +
                    historicalEntries.map((e: { url: string; description: string }) =>
                      `- ${e.url}\n  Previous summary: ${e.description}`
                    ).join('\n');
                }
              }
            }
          } catch (err) {
            logger.warn('[QuickOrchestrator] Failed to fetch historical URLs (non-fatal):', err);
          }
        }

        const researcherPromptTemplate = loadPrompt('researcher', '..');
        const maxScrapeBatches = getMaxScrapeBatches(this.config);
        const maxScrapeBatchesDisplay = maxScrapeBatches > 99 ? 'unlimited' : maxScrapeBatches.toString();

        const quickEvidenceSection =
            '## Search\n' +
            'You have access to the `search` tool. You get EXACTLY ONE search call — make it count.\n' +
            'Submit **5–10 diverse, specific, and non-overlapping queries** covering the most important angles of the topic.\n' +
            'Each query must target a distinct piece of information. Avoid generic queries.\n' +
            'Your goal is to gather a focused, high-quality pool of initial links.\n\n' +
            '## Scrape\n' +
            `After searching, scrape the best sources using the \`scrape\` tool (up to ${maxScrapeBatchesDisplay} batches, up to 4 URLs each).\n` +
            'Prioritize primary sources and authoritative data.';
        
        const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
            .replace('{{goal}}', query)
            .replace('{{store_section}}', storeSection)
            .replace('{{evidence_section}}', quickEvidenceSection)
            .replace('{{coordination_section}}', '')
            .replace('{{extra_tool_guidelines}}', '- `search`: Perform broad web searches (Round 1 only).\n- `stored_search`: Query the local knowledge store for summaries of findings from previous research sessions.');

        logger.debug(`[QuickOrchestrator] System Prompt:\n${prompt}`);

        let lastSeenSearchCount = 0;
        const session = await createResearcherSession({
          cwd: ctx.cwd,
          ctxModel: model,
          modelRegistry: ctx.modelRegistry,
          settingsManager: (ctx as any).settingsManager,
          systemPrompt: prompt,
          extensionCtx: ctx,
          excludeTools: this.options.excludeTools || ['grep'],
          getGlobalState: (): SystemResearchState => ({
            version: 1,
            researchId: this.options.researchId,
            rootQuery: query,
            complexity: 1,
            currentRound: 1,
            status: 'researching',
            lastUpdated: Date.now(),
            initialAgenda: [],
            allScrapedLinks: [],
            aspects: {},
          }),
          updateGlobalLinks: (links) => registerScrapedLinks(this.options.researchId, links),
          onSearchProgress: (links) => {
            lastSeenSearchCount = links;
            observer?.onSearchProgress?.(links);
          },
        });

        const sessionService = await getService<any>(ServiceNames.RESEARCH_SESSION_SERVICE);
        sessionService.registerSession(this.options.researchId, 'quick', session, () => session.abort().catch(() => {}));

        const subscription = session.subscribe((event: AgentSessionEvent) => {
            if (event.type === 'message_end') {
                const msg = event.message as unknown as ResearchMessage;
                if (msg?.['role'] !== 'assistant') return;

                // Log thinking content if present
                const content = msg['content'];
                if (Array.isArray(content)) {
                    const thinking = content.find(c => c.type === 'thinking');
                    if (thinking?.thinking) {
                        logger.debug(`[QuickOrchestrator] Researcher Thinking:\n${thinking.thinking}`);
                    }
                }

                const rawUsage = msg['usage'] as any;
                if (rawUsage) {
                    const parsed = parseTokenUsage(rawUsage);
                    const tokens = calculateTotalTokens(parsed);
                    
                    // Ultra-accurate cost calculation
                    let cost = parsed.cost?.total ?? rawUsage.cost?.total ?? 0;
                    if (cost === 0 && tokens > 0) {
                        const calculatedCost = calculateCost(model, rawUsage);
                        cost = calculatedCost.total;
                    }

                    if (tokens > 0 || cost > 0) {
                        metrics.increment('llm_tokens_total', tokens, { component: 'quick_researcher', complexity: '0' });
                        metrics.increment('llm_cost_total', cost, { component: 'quick_researcher', complexity: '0' });
                        observer?.onResearcherProgress?.('quick', undefined, tokens, cost);
                        observer?.onTokensConsumed?.(tokens, cost);
                    }
                }
            } else if (event.type === 'tool_execution_start') {
                observer?.onResearcherProgress?.('quick', event.toolName);
                if (event.toolName === 'search') {
                    metrics.increment('research_searches_total', 1, { mode: 'quick' });
                    observer?.onSearchStart?.(event.args.queries || []);
                }
            } else if (event.type === 'tool_execution_end') {
                observer?.onResearcherProgress?.('quick', `done:${event.toolName}`);
                if (event.toolName === 'search') {
                    observer?.onSearchComplete?.(lastSeenSearchCount);
                }
            }
        });

        try {
          let timeoutId: NodeJS.Timeout;
          const timeoutPromise = new Promise<void>((_, reject) => {
              timeoutId = setTimeout(() => {
                  const msg = `Quick research timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`;
                  session.abort().catch((err) => {
                      logger.warn('[QuickOrchestrator] Failed to abort timed-out session:', err);
                  }).finally(() => reject(new Error(msg)));
              }, this.config.RESEARCHER_TIMEOUT_MS);
          });

          // Keep onAbort in outer scope so the listener can be removed in finally
          // whether the race resolves via session.prompt, timeout, or abort.
          let abortCleanup: (() => void) | undefined;
          try {
            await Promise.race([
              session.prompt(query),
              timeoutPromise,
              ...(signal ? [
                new Promise<never>((_, reject) => {
                  const onAbort = () => {
                    session.abort().catch(err => logger.warn('[QuickOrchestrator] Failed to abort session on signal:', err));
                    reject(new Error('Aborted'));
                  };
                  if (signal.aborted) {
                    onAbort();
                  } else {
                    signal.addEventListener('abort', onAbort, { once: true });
                    (abortCleanup as AbortCleanup) = () => signal.removeEventListener('abort', onAbort);
                  }
                })
              ] : []),
            ]);
          } finally {
            clearTimeout(timeoutId!);
            if (abortCleanup) (abortCleanup as () => void)();
          }
          
          const result = ensureAssistantResponse(session, 'Quick');
          const sessionDuration = Date.now() - sessionStart;
          metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'quick', complexity: '0', status: 'success' });
          logger.debug(`[QuickOrchestrator] Researcher Final Response:\n${result}`);
          
          // Extract citations and store agent-synthesized descriptions for vector/semantic search
          // Quick research is single-pass, so this is the final synthesis point
          if (this.config.KNOWLEDGE_STORE_ENABLED) {
            try {
              const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE);
              if (!writer) {
                logger.warn('[QuickOrchestrator] Writer queue service not available');
              } else {
                const citations = parseCitations(result);
                if (citations.length === 0) {
                  logger.warn('[QuickOrchestrator] Researcher produced no parseable CITED LINKS — no descriptions stored for this session');
                }
                let enqueued = 0;
                for (const cit of citations) {
                  if (cit.url && cit.description) {
                    const fullContent = getCachedScrapedContent(this.options.researchId, cit.url);
                    writer.enqueue({
                      url: normalizeUrl(cit.url),
                      markdown: cit.description,
                      content: fullContent,
                      metadata: {
                        ingestionType: 'synthesis-description',
                        source: 'researcher',
                        synthesizedAt: new Date().toISOString(),
                        description: cit.description,
                        fullContentSnippet: fullContent?.substring(0, 5000)
                      }
                    });
                    enqueued++;
                  }
                }
                // Drain so concurrent or subsequent sessions see these entries immediately
                // rather than relying solely on shutdownKnowledgeStore's drain.
                if (enqueued > 0) await writer.drain();
              }
            } catch (err) {
              logger.warn('[QuickOrchestrator] Failed to store link descriptions (non-fatal):', err);
            }
          }

          metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'success' });
          observer?.onComplete?.(result);
          return result;
        } catch (error) {
          const sessionDuration = Date.now() - sessionStart;
          metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'quick', complexity: '0', status: 'error' });
          metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'error' });
          observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
          throw error;
        } finally {
          subscription();
          try {
            await session.abort();
          } catch (err) {
            logger.warn('[QuickOrchestrator] Failed to abort session during cleanup:', err);
          }
          try {
            sessionService.unregisterSession(this.options.researchId, 'quick');
          } catch (err) {
            logger.warn('[QuickOrchestrator] Failed to unregister session:', err);
          }
        }
    } finally {
        await cleanupResearchServices(researchId);
    }
  }
}