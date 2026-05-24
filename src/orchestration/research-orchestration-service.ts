/**
 * Research Orchestration Service
 *
 * Handles the core orchestration logic for multi-round research.
 * Responsible for:
 * - Multi-round research coordination
 * - Agent spawning and concurrent execution management
 * - Search result distribution to researchers
 * - Health check integration
 * - Knowledge store integration for link descriptions
 */

import type { ResearcherConfig, ResearchPlan } from '../core/service-interfaces.ts';
import type { QueryResultWithError } from '../web-research/types.ts';
import type { ResearchObserver } from './research-observer.ts';
import type { AbortCleanup, ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import type { ExtendedExtensionContext } from '../types/extension-context.ts';
import type { Model } from '@mariozechner/pi-ai';
import type { PlanningService } from '../core/planning-service.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';
import { registerScrapedLinks } from '../utils/shared-links.ts';
import { ensureAssistantResponse, parseCitations } from '../utils/text-utils.ts';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { getWriterQueue } from '../knowledge/index.ts';
import { getCachedScrapedContent, normalizeUrl } from '../utils/shared-links.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import {
  RESEARCHER_LAUNCH_DELAY_MS,
} from '../constants.ts';

/**
 * Options for running researchers in parallel
 */
export interface RunResearchersOptions {
  configs: ResearcherConfig[];
  linksMap: Map<string, string[]>;
  sessionId: string;
  researchId: string;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  ctx: any;
  model: Model<any>;
  researchConfig: any;
  planningService: PlanningService;
  observer?: ResearchObserver;
  signal?: AbortSignal;
  sessionStart: number;
}

/**
 * Options for running a single researcher
 */
export interface RunResearcherOptions {
  config: ResearcherConfig;
  initialLinks: string[];
  historicalUrls: string[];
  sessionId: string;
  researchId: string;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  ctx: any;
  model: Model<any>;
  researchConfig: any;
  planningService: PlanningService;
  observer?: ResearchObserver;
  signal?: AbortSignal;
  sessionStart: number;
}

/**
 * Research Orchestration Service
 *
 * Handles core orchestration logic for multi-round research.
 */
export class ResearchOrchestrationService {
  /**
   * Distribute search results to researchers based on query matching
   * @param plan - Research plan with researchers and queries
   * @param results - Search results from queries
   * @returns Map of researcher ID -> array of URLs
   */
  distributeResults(plan: ResearchPlan, results: QueryResultWithError[]): Map<string, string[]> {
    const startTime = Date.now();
    const linkMap = new Map<string, string[]>();
    if (!plan.researchers) return linkMap;

    plan.researchers.forEach((r) => {
      const ownedLinks: string[] = [];
      const rQueries = new Set(
        r.queries
          .map((q: string) => q.toLowerCase().trim())
          .filter(q => q.length > 0)
      );

      // Convert Set to array once per researcher to avoid repeated spreads in the inner loop
      const rQueriesArr = Array.from(rQueries);

      results.forEach((res) => {
        const resQuery = String(res.query ?? '').toLowerCase().trim();
        if (resQuery.length === 0) return;

        // Check direct match first (O(1))
        let matched = rQueries.has(resQuery);

        // Fallback to fuzzy includes matching (O(Q*L))
        if (!matched) {
          for (let i = 0; i < rQueriesArr.length; i++) {
            const rq = rQueriesArr[i] as string;
            if (resQuery.includes(rq) || rq.includes(resQuery)) {
              matched = true;
              break;
            }
          }
        }

        if (matched) {
          const items = res.results ?? [];
          for (let i = 0; i < items.length; i++) {
            const url = items[i]?.url;
            if (url) ownedLinks.push(url);
          }
        }
      });
      linkMap.set(String(r.id), Array.from(new Set(ownedLinks)));
    });

    logger.debug(`[ResearchOrchestrationService] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }

  /**
   * Run multiple researchers in parallel with concurrency control
   * @param options - Options for running researchers
   */
  async runResearchersParallel(options: RunResearchersOptions): Promise<void> {
    const {
      configs,
      linksMap,
      sessionId,
      researchId,
      round,
      query,
      complexity,
      ctx,
      model,
      researchConfig: config,
      planningService,
      observer,
      signal,
      sessionStart,
    } = options;

    const queue = [...configs];
    const active = new Set<Promise<void>>();
    const { MAX_CONCURRENT_RESEARCHERS } = config;
    let lastLaunchTime = 0;

    while (queue.length > 0 || active.size > 0) {
      if (signal?.aborted) throw new Error('Research aborted.');

      while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
        const now = Date.now();
        const timeSinceLastLaunch = now - lastLaunchTime;
        if (lastLaunchTime > 0 && timeSinceLastLaunch < RESEARCHER_LAUNCH_DELAY_MS) {
          await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS - timeSinceLastLaunch));
        }

        const configItem = queue.shift()!;
        lastLaunchTime = Date.now();
        const links = linksMap.get(String(configItem.id)) || [];
        const histLinks = configItem.historicalLinks || [];

        const p = this.runResearcher({
          config: configItem,
          initialLinks: links,
          historicalUrls: histLinks,
          sessionId,
          researchId,
          round,
          query,
          complexity,
          ctx,
          model,
          researchConfig: config,
          planningService,
          observer,
          signal,
          sessionStart,
        }).catch((err) => {
          const errMsg = err.message || String(err);
          logger.error(`[ResearchOrchestrationService] Researcher ${configItem.id} failed: ${errMsg}`);
          observer?.onResearcherFailure?.(String(configItem.id), errMsg);
          // Import dynamically to avoid circular dependency
          import('../utils/session-state.ts').then(({ recordResearcherFailure }) => {
            recordResearcherFailure(sessionId, researchId, String(configItem.id));
          });
        }).finally(() => {
          active.delete(p);
        });

        active.add(p);
      }

      if (active.size > 0) {
        await Promise.race(active);

        // Check if we should stop due to excessive failures
        const { shouldStopResearch } = await import('../utils/session-state.ts');
        if (shouldStopResearch(sessionId, researchId)) {
          // Abort all active sessions
          const { getResearchSessionService } = await import('./research-session-manager.ts');
          const sessionService = getResearchSessionService();
          await sessionService.abortAllSessions();

          throw new Error('Research stopped due to excessive infrastructure failures. Multiple researchers failed.');
        }
      }
    }
  }

  /**
   * Run a single researcher with retries
   * @param options - Options for running the researcher
   * @returns Promise that resolves when the researcher completes
   */
  async runResearcher(options: RunResearcherOptions): Promise<void> {
    const {
      config: researcherConfig,
      initialLinks,
      historicalUrls,
      sessionId,
      researchId,
      round,
      query,
      complexity,
      ctx,
      model,
      researchConfig: config,
      planningService,
      observer,
      signal,
      sessionStart,
    } = options;

    // Prevent unused variable warning for sessionId, sessionStart
    void sessionId;
    void sessionStart;

    const id = String(researcherConfig.id);
    observer?.onResearcherStart?.(id, researcherConfig.name, researcherConfig.goal, round);
    metrics.increment('researchers_launched_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });

    const currentPlan = planningService.getCurrentPlan();
    const previousQueriesSection = currentPlan?.allQueries && currentPlan.allQueries.length > 0
      ? `\n### Previous Queries (Sibling Researchers)\n${currentPlan.allQueries.map(q => `- ${q}`).join('\n')}\n`
      : '';

    let storeSection = '';
    if (historicalUrls.length > 0) {
      storeSection = '\n## Historical Knowledge Store\n' +
        'The following URLs were found in your local knowledge store. Scrape them to retrieve a historical summary and the full content.\n' +
        historicalUrls.map(u => `- ${u}`).join('\n');
    }

    const researcherPromptTemplate = loadPrompt('researcher', '..');
    if (initialLinks.length === 0 && historicalUrls.length === 0) {
      logger.warn(`[ResearchOrchestrationService] Researcher ${id} has no initial search results or historical links; skipping.`);
      observer?.onResearcherComplete?.(id, '');
      return;
    }

    let evidenceSection = '';
    if (initialLinks.length > 0) {
      evidenceSection = `## Evidence Provided\nInitial search results provided the following URLs to investigate:\n${initialLinks.map(l => `- ${l}`).join('\n')}`;
    }

    const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
      .replace('{{goal}}', researcherConfig.goal)
      .replace('{{store_section}}', storeSection)
      .replace('{{evidence_section}}', evidenceSection)
      .replace('{{coordination_section}}', previousQueriesSection)
      .replace('{{extra_tool_guidelines}}', '');

    logger.debug(`[ResearchOrchestrationService] Researcher ${id} System Prompt:\n${prompt}`);

    const extendedCtx = ctx as unknown as ExtendedExtensionContext;
    const maxAttempts = config.RESEARCHER_MAX_RETRIES + 1;
    let lastError: unknown;
    const researcherExecutionStartMs = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
        logger.warn(`[ResearchOrchestrationService] Researcher ${id} retry ${attempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
        observer?.onResearcherProgress?.(id, `Retry ${attempt - 1}...`);
        await new Promise(r => setTimeout(r, delay));
      }

      const session = await createResearcherSession({
        cwd: ctx.cwd,
        ctxModel: model,
        modelRegistry: ctx.modelRegistry,
        settingsManager: extendedCtx['settingsManager'] ?? undefined as any,
        systemPrompt: prompt,
        extensionCtx: ctx,
        noSearch: true,
        noStoredSearch: true,
        getGlobalState: (): SystemResearchState => ({
          version: 1,
          researchId,
          rootQuery: query,
          complexity,
          currentRound: 1,
          status: 'researching',
          lastUpdated: Date.now(),
          initialAgenda: [],
          allScrapedLinks: [],
          aspects: {},
        }),
        updateGlobalLinks: (links) => registerScrapedLinks(researchId, links),
        onSearchProgress: (links) => {
          observer?.onResearcherProgress?.(id, `${links} Results`);
        },
      });

      // Register session with session service
      const { getResearchSessionService } = await import('./research-session-manager.ts');
      const sessionService = getResearchSessionService();
      sessionService.registerSession(id, session, () => session.abort().catch(() => {}));

      const subscription = session.subscribe((event: any) => {
        if (event.type === 'message_end') {
          const msg = event.message as unknown as ResearchMessage;
          if (msg?.['role'] !== 'assistant') return;
          const rawUsage = msg['usage'] as { cost?: { total: number } } | undefined;
          if (rawUsage) {
            const parsed = parseTokenUsage(rawUsage);
            const tokens = calculateTotalTokens(parsed);
            const cost: number = rawUsage.cost?.total ?? 0;
            if (tokens > 0 || cost > 0) {
              metrics.increment('llm_tokens_total', tokens, { component: 'researcher', complexity: String(complexity) });
              metrics.increment('llm_cost_total', cost, { component: 'researcher', complexity: String(complexity) });
              observer?.onResearcherProgress?.(id, undefined, tokens, cost);
              observer?.onTokensConsumed?.(tokens, cost);
            }
          }
        } else if (event.type === 'tool_execution_start') {
          observer?.onResearcherProgress?.(id, `${event.toolName}`);
        } else if (event.type === 'tool_execution_end') {
          observer?.onResearcherProgress?.(id, `done:${event.toolName}`);
        }
      });

      try {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            const msg = `Researcher ${id} (${researcherConfig.name}) timed out after ${config.RESEARCHER_TIMEOUT_MS}ms`;
            session.abort().catch((err) => {
              logger.warn('[ResearchOrchestrationService] Failed to abort timed-out researcher session:', err);
            }).finally(() => reject(new Error(msg)));
          }, config.RESEARCHER_TIMEOUT_MS);
        });

        let abortCleanup: (() => void) | undefined;
        try {
          await Promise.race([
            session.prompt(`Topic: ${researcherConfig.name}\nGoal: ${researcherConfig.goal}\n\nPerform your research and submit your full report now.`),
            timeoutPromise,
            ...(signal ? [
              new Promise<never>((_, reject) => {
                const onAbort = () => {
                  session.abort().catch(err => logger.warn('[ResearchOrchestrationService] Failed to abort session on signal:', err));
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
          abortCleanup?.();
        }

        const responseText = ensureAssistantResponse(session, id);
        const researcherDuration = Date.now() - researcherExecutionStartMs;
        metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round) });
        logger.debug(`[ResearchOrchestrationService] Researcher ${id} Final Response:\n${responseText}`);

        // Store report in synthesis service
        const { getResearchSynthesisService } = await import('./research-session-manager.ts');
        const synthesisService = getResearchSynthesisService();
        synthesisService.storeReport(`${round}.${id}`, responseText);

        observer?.onResearcherComplete?.(id, responseText);
        return;
      } catch (err) {
        const researcherDuration = Date.now() - researcherExecutionStartMs;
        metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round), status: 'error' });
        metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${id} attempt ${attempt} failed: ${errMsg}; will retry`);
        } else {
          logger.error(`[ResearchOrchestrationService] Researcher ${id} failed all ${maxAttempts} attempts: ${errMsg}`);
          metrics.increment('researcher_retries_exhausted_total', 1, { mode: 'deep', complexity: String(complexity) });
        }
      } finally {
        subscription();
        await session.abort().catch((err) => {
          logger.warn(`[ResearchOrchestrationService] Failed to abort researcher session ${id}:`, err);
        });
        sessionService.unregisterSession(id);
      }
    }

    throw lastError;
  }

  /**
   * Run a search burst for the given queries
   * @param queries - Array of search queries
   * @param config - Research configuration
   * @param observer - Optional observer for progress callbacks
   * @param signal - Optional abort signal
   * @returns Search results
   */
  async runSearchBurst(
    queries: string[],
    config: any,
    complexity: 1 | 2 | 3,
    observer?: ResearchObserver,
    signal?: AbortSignal
  ): Promise<QueryResultWithError[]> {
    observer?.onSearchStart?.(queries);
    const searchStartMs = Date.now();
    const searchResults = await search(queries, config, signal, (links) => {
      observer?.onSearchProgress?.(links);
    });
    const searchDuration = Date.now() - searchStartMs;
    metrics.observe('research_search_latency_ms', searchDuration, { mode: 'deep', complexity: String(complexity) });
    const totalResults = searchResults.reduce((acc, r) => acc + (r.results?.length || 0), 0);
    metrics.observe('research_search_results_total', totalResults, { mode: 'deep', complexity: String(complexity) });
    observer?.onSearchComplete?.(totalResults);
    logger.info(`[ResearchOrchestrationService] Search burst completed. Total results: ${totalResults}`);
    return searchResults;
  }

  /**
   * Store link descriptions to knowledge store for a specific round
   * @param round - Round number
   * @param researchId - Research ID
   * @param config - Research configuration
   */
  async storeLinkDescriptions(round: number, researchId: string, config: any): Promise<void> {
    if (!config.KNOWLEDGE_STORE_ENABLED) return;

    try {
      const { getResearchSynthesisService } = await import('./research-session-manager.ts');
      const synthesisService = getResearchSynthesisService();
      const writer = await getWriterQueue();
      const roundPrefix = `${round}.`;
      let enqueued = 0;

      for (const [key, report] of synthesisService.getAllReports().entries()) {
        if (!key.startsWith(roundPrefix)) continue;
        const citations = parseCitations(report);
        if (citations.length === 0) {
          logger.warn(`[ResearchOrchestrationService] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored`);
        }
        for (const cit of citations) {
          if (cit.url && cit.description) {
            writer.enqueue({
              url: normalizeUrl(cit.url),
              markdown: cit.description,
              content: getCachedScrapedContent(researchId, cit.url),
              metadata: {
                ingestionType: 'synthesis-description',
                source: 'researcher',
                sourceOrigin: cit.source,
                synthesizedAt: new Date().toISOString(),
              }
            });
            enqueued++;
          }
        }
      }

      if (enqueued > 0) {
        await writer.drain();
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to store link descriptions (non-fatal):', err);
    }
  }

  /**
   * Run health check and log status
   * @param round - Current round number
   */
  async runHealthCheck(round: number): Promise<void> {
    if (round <= 1) return;

    try {
      const health = await healthRegistry.runAll();
      if (health.status === 'healthy') {
        logger.debug(`[ResearchOrchestrationService] Health status at Round ${round}: ✅ All systems operational`);
      } else if (health.status === 'degraded') {
        const degraded = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.warn(`[ResearchOrchestrationService] Health status at Round ${round}: ⚠️ Degraded (${degraded.join(', ')})`);
      } else {
        const failed = health.components.filter(c => !c.healthy).map(c => c.component);
        logger.error(`[ResearchOrchestrationService] Health status at Round ${round}: ❌ Unhealthy (${failed.join(', ')})`);
      }
    } catch (err) {
      logger.warn('[ResearchOrchestrationService] Failed to check health status:', err);
    }
  }

  /**
   * Get elapsed time since start
   * @param startTime - Start time in milliseconds
   * @returns Formatted elapsed time string
   */
  getElapsedTime(startTime: number): string {
    const s = Math.round((Date.now() - startTime) / 1000);
    return `+${s}s`;
  }
}