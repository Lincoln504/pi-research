/**
 * Deep Research Orchestrator
 *
 * This is the heart of the pi-research system. It implements a multi-round,
 * multi-agent research loop inspired by systems like OpenAI Deep Research.
 */

import {
    type ExtensionContext,
    type AgentSessionEvent
} from '@mariozechner/pi-coding-agent';
import { type Model } from '@mariozechner/pi-ai';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { PlanningService } from '../core/planning-service.ts';
import { createResearcherSession } from './researcher.ts';
import { search } from '../web-research/search.ts';
import { recordResearcherFailure, shouldStopResearch } from '../utils/session-state.ts';
import type { QueryResultWithError } from '../web-research/types.ts';
import { ensureAssistantResponse, parseCitations } from '../utils/text-utils.ts';
import {
    MAX_ROUNDS_LEVEL_1,
    MAX_ROUNDS_LEVEL_2,
    MAX_ROUNDS_LEVEL_3,
    RESEARCHER_LAUNCH_DELAY_MS,
    MAX_EXTRA_ROUNDS,
} from '../constants.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { Type, type Static } from 'typebox';
import type { ResearchObserver } from './research-observer.ts';
import { getStore, getWriterQueue } from '../knowledge/index.ts';
import { registerScrapedLinks, normalizeUrl, getCachedScrapedContent } from '../utils/shared-links.ts';
import { healthRegistry } from '../healthcheck/index.ts';
import { metrics } from '../utils/metrics.ts';
import type { AbortCleanup, ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import type { ExtendedExtensionContext } from '../types/extension-context.ts';

const ResearcherConfigSchema = Type.Object({
    id: Type.Union([Type.String(), Type.Number()]),
    name: Type.String(),
    goal: Type.String(),
    queries: Type.Array(Type.String()),
    historicalLinks: Type.Optional(Type.Array(Type.String()))
});

const ResearchPlanSchema = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate')])),
    researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
    allQueries: Type.Optional(Type.Array(Type.String())),
    content: Type.Optional(Type.String())
});

type ResearchPlan = Static<typeof ResearchPlanSchema>;
type ResearcherConfig = Static<typeof ResearcherConfigSchema>;

export interface DeepResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  complexity: 1 | 2 | 3;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  config?: Config;
}

export class DeepResearchOrchestrator {
  private reports = new Map<string, string>(); // researcherId -> report
  private currentRound = 0;
  private startTime: number = Date.now();
  private config: Config;
  private activeSessions = new Map<string, { abort(): Promise<void> }>();
  private readonly sessionStart: number = Date.now();

  constructor(private options: DeepResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
  }

  private async getPlanningService(): Promise<PlanningService> {
    return await getService<PlanningService>(ServiceNames.PLANNING);
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.startTime) / 1000);
    return `+${s}s`;
  }

  /**
   * Run the multi-round research loop
   */
  async run(signal?: AbortSignal): Promise<string> {
    logger.log(`[Orchestrator] Starting deep research with complexity ${this.options.complexity}`);
    this.options.observer?.onStart?.(this.options.query, this.options.complexity);
    metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity) });

    // Knowledge Store Context Injection
    let historicalLinksSection = '';
    if (this.config.KNOWLEDGE_STORE_ENABLED) {
      try {
        const store = await getStore();
        const historicalUrls = await store.findRelevantUrls(this.options.query, { limit: 20 });
        if (historicalUrls.length > 0) {
          historicalLinksSection = '\n\n## Historical Knowledge Store (Discovery)\n' +
            'The following relevant URLs were found in your local knowledge store. They contain summaries of findings from previous research sessions:\n\n' +
            historicalUrls.map(u => `- ${u}`).join('\n') +
            '\n\nDistribute these historical links among your researchers for re-investigation. Researchers will retrieve a historical summary hint and the fresh full content when scraping.';
        }
      } catch (err) {
        logger.warn('[Orchestrator] Failed to fetch historical context (non-fatal):', err);
      }
    }

    const planningService = await this.getPlanningService();
    const coordStartMs = Date.now();

    try {
      // 1. Initial Planning
      this.options.observer?.onPlanningStart?.(1);

      // Generate plan using PlanningService
      let currentPlan = await planningService.generatePlan({
        query: this.options.query,
        complexity: this.options.complexity,
        model: this.options.model,
        config: this.config,
        sessionContext: {
          sessionId: this.options.sessionId,
          researchId: this.options.researchId,
        },
        historicalLinksSection,
        signal,
      });

      if (!currentPlan || !currentPlan.researchers) throw new Error('Coordinator failed to plan any researchers.');

      // Track tokens for observer
      if (this.options.observer) {
        // PlanningService handles metrics internally, but we need to notify observer
        // Since we don't have direct access to token usage, we'll use a placeholder
        // The actual token tracking happens in PlanningService
      }
      this.options.observer?.onPlanningSuccess?.(currentPlan);

      logger.log(`[Orchestrator] ${this.elapsed()} Coordinator done in ${((Date.now() - coordStartMs) / 1000).toFixed(1)}s - planned ${currentPlan.researchers?.length || 0} researcher(s)`);
      const coordDuration = Date.now() - coordStartMs;
      metrics.observe('coordinator_latency_ms', coordDuration, { complexity: String(this.options.complexity) });
      metrics.observe('coordinator_researchers_planned', currentPlan.researchers?.length || 0, { complexity: String(this.options.complexity) });

      const maxRounds = this.options.complexity === 1 ? MAX_ROUNDS_LEVEL_1 :
                           this.options.complexity === 2 ? MAX_ROUNDS_LEVEL_2 :
                           MAX_ROUNDS_LEVEL_3;
      metrics.increment('research_queries_total', currentPlan.allQueries?.length || 0, { mode: 'deep', complexity: String(this.options.complexity) });

      // Add queries to history in PlanningService
      if (currentPlan.allQueries) {
        planningService.addToQueryHistory(currentPlan.allQueries);
      }

      while (this.currentRound < maxRounds + MAX_EXTRA_ROUNDS) {
          if (signal?.aborted) throw new Error("Research aborted.");
          this.currentRound++;

          // Log health status at the start of each round for long-running research
          if (this.currentRound > 1) {
            try {
              const health = await healthRegistry.runAll();
              if (health.status === 'healthy') {
                logger.debug(`[Orchestrator] Health status at Round ${this.currentRound}: ✅ All systems operational`);
              } else if (health.status === 'degraded') {
                const degraded = health.components.filter(c => !c.healthy).map(c => c.component);
                logger.warn(`[Orchestrator] Health status at Round ${this.currentRound}: ⚠️ Degraded (${degraded.join(', ')})`);
              } else {
                const failed = health.components.filter(c => !c.healthy).map(c => c.component);
                logger.error(`[Orchestrator] Health status at Round ${this.currentRound}: ❌ Unhealthy (${failed.join(', ')})`);
              }
            } catch (err) {
              logger.warn('[Orchestrator] Failed to check health status:', err);
            }
          }
          if (!currentPlan || !currentPlan.researchers || currentPlan.researchers.length === 0) break;

          this.options.observer?.onRoundStart?.(this.currentRound);
          // 2. Search Burst
          // CRITICAL: Researchers MUST have search results. If no queries, this is an error.
          if (!currentPlan.allQueries || currentPlan.allQueries.length === 0) {
              throw new Error(`[Orchestrator] Delegated ${currentPlan.researchers?.length || 0} researchers but no queries to search. Researchers cannot run without search results.`);
          }

          this.options.observer?.onSearchStart?.(currentPlan.allQueries);
          const searchStartMs = Date.now();
          const searchResults = await search(currentPlan.allQueries, this.config, signal, (links) => {
              this.options.observer?.onSearchProgress?.(links);
          });
          const searchDuration = Date.now() - searchStartMs;
          metrics.observe('research_search_latency_ms', searchDuration, { mode: 'deep', complexity: String(this.options.complexity) });
          const totalResults = searchResults.reduce((acc, r) => acc + (r.results?.length || 0), 0);
          metrics.observe('research_search_results_total', totalResults, { mode: 'deep', complexity: String(this.options.complexity) });
          this.options.observer?.onSearchComplete?.(totalResults);
          logger.info(`[Orchestrator] Search burst completed. Distributing results to ${currentPlan.researchers.length} researcher(s)...`);
          const researcherLinks = this.distributeResults(currentPlan, searchResults);
          logger.info(`[Orchestrator] Starting ${currentPlan.researchers.length} researchers in parallel with search results...`);
          const researcherStartMs = Date.now();
          await this.runResearchersParallel(currentPlan.researchers, researcherLinks, signal);
          const researcherDuration = Date.now() - researcherStartMs;
          metrics.observe('research_researcher_latency_ms', researcherDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });

          // Store researcher-generated link descriptions for vector search.
          // Researchers read the full scraped content and write comprehensive descriptions;
          // the evaluator only receives summaries so its descriptions are far less detailed.
          // Only process the current round's reports (keyed as "<round>.<id>").
          if (this.config.KNOWLEDGE_STORE_ENABLED) {
            try {
              const writer = await getWriterQueue();
              const roundPrefix = `${this.currentRound}.`;
              let enqueued = 0;
              for (const [key, report] of this.reports.entries()) {
                if (!key.startsWith(roundPrefix)) continue;
                const citations = parseCitations(report);
                if (citations.length === 0) {
                  logger.warn(`[Orchestrator] Researcher ${key} produced no parseable CITED LINKS - no descriptions stored for this report`);
                }
                for (const cit of citations) {
                  if (cit.url && cit.description) {
                    writer.enqueue({
                      url: normalizeUrl(cit.url),
                      markdown: cit.description,
                      content: getCachedScrapedContent(this.options.researchId, cit.url),
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
              // Drain before evaluate() so findRelevantUrls() sees this round's
              // new entries via vector search. Full-text search index is rebuilt
              // asynchronously at session end/shutdown.
              if (enqueued > 0) {
                await writer.drain();
              }
            } catch (err) {
              logger.warn('[Orchestrator] Failed to store link descriptions (non-fatal):', err);
            }
          }

          const mustSynthesize = this.currentRound >= maxRounds + MAX_EXTRA_ROUNDS;
          const evaluationStartMs = Date.now();
          currentPlan = await this.evaluate(signal, mustSynthesize, planningService);
          const evaluationDuration = Date.now() - evaluationStartMs;
          metrics.observe('research_evaluation_latency_ms', evaluationDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });

          if (currentPlan.action === 'synthesize') {
              metrics.increment('research_synthesis_decisions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
              const synthesis = this.ensureCitedLinks(currentPlan.content || this.buildFallbackSynthesis());
              this.options.observer?.onComplete?.(synthesis);
              const sessionDuration = Date.now() - this.sessionStart;
              metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
              metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
              metrics.observe('researchers_total', planningService.getTotalResearchersPlanned(), { mode: 'deep', complexity: String(this.options.complexity) });
              metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
              await this.cleanup();
              return synthesis;
          }
          metrics.increment('research_delegation_decisions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
      }

      const finalSynthesis = this.buildFallbackSynthesis();
      this.options.observer?.onComplete?.(finalSynthesis);
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
      metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.observe('researchers_total', planningService.getTotalResearchersPlanned(), { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'success' });
      await this.cleanup();
      return finalSynthesis;

    } catch (error) {
      if (error instanceof Error && error.message === 'Research aborted.') {
        await this.cleanup();
        throw error;
      }
      const sessionDuration = Date.now() - this.sessionStart;
      metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'deep', complexity: String(this.options.complexity), status: 'error' });
      metrics.observe('research_rounds_total', this.currentRound, { mode: 'deep', complexity: String(this.options.complexity) });
      metrics.increment('research_sessions_total', 1, { mode: 'deep', complexity: String(this.options.complexity), status: 'error' });
      logger.error('[Orchestrator] Run failed:', error);
      if (this.reports.size > 0) {
        const partial = this.buildFallbackSynthesis();
        this.options.observer?.onComplete?.(partial);
        this.options.observer?.onError?.(error as Error);
        await this.cleanup();
        return partial;
      }
      this.options.observer?.onError?.(error as Error);
      await this.cleanup();
      return "Research failed. Check debug logs for details.";
    }
  }

  /**
   * Clean up internal state and abort all active researcher sessions.
   */
  private async cleanup(): Promise<void> {
    const aborts = Array.from(this.activeSessions.values()).map(s =>
      s.abort().catch(() => {})
    );
    await Promise.all(aborts);
    this.activeSessions.clear();
    this.reports.clear();
  }

  /**
   * Guarantee the synthesis has a ### CITED LINKS section.
   * If the evaluator omitted it (LLM non-compliance or output truncation),
   * extract all URLs from researcher reports and append them.
   */
  private ensureCitedLinks(synthesis: string): string {
    if (/###\s*CITED LINKS/i.test(synthesis)) return synthesis;

    logger.warn('[Orchestrator] Synthesis missing CITED LINKS - rebuilding from researcher reports');

    // Parse each researcher report's CITED LINKS section and collect unique URLs
    const seen = new Set<string>();
    const links: { url: string; desc: string; source?: string }[] = [];

    for (const report of this.reports.values()) {
      const citations = parseCitations(report);
      for (const cit of citations) {
        if (!seen.has(cit.url)) {
          seen.add(cit.url);
          links.push({ url: cit.url, desc: cit.description, source: cit.source });
        }
      }
    }

    if (links.length === 0) return synthesis;

    const linksSection = links
      .map(({ url, desc, source }, i) => {
        const sourcePart = source ? ` [Source: ${source}]` : '';
        return `[${i + 1}] ${url}${sourcePart}${desc ? ` - ${desc}` : ''}`;
      })
      .join('\n');

    return `${synthesis}\n\n### CITED LINKS\n${linksSection}`;
  }

  private buildFallbackSynthesis(): string {
    const reportCount = this.reports.size;
    const roundInfo = this.currentRound > 0 ? ` (up to Round ${this.currentRound})` : "";
    let synthesis = `# Research Findings${roundInfo}\n\n`;

    if (reportCount === 0) {
        synthesis += "_No researcher reports were generated before the process stopped._";
    } else {
        synthesis += `*This is an automated synthesis of ${reportCount} individual researcher report(s) gathered before the process was interrupted.*\n\n`;
        synthesis += Array.from(this.reports.entries())
            .map(([id, report]) => `## Researcher ${id}\n\n${report}`)
            .join('\n\n---\n\n');
    }

    return synthesis;
  }

  private distributeResults(plan: ResearchPlan, results: QueryResultWithError[]): Map<string, string[]> {
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
    logger.debug(`[Orchestrator] Distributed ${results.length} results in ${Date.now() - startTime}ms`);
    return linkMap;
  }

  private async runResearchersParallel(configs: ResearcherConfig[], linksMap: Map<string, string[]>, signal?: AbortSignal) {
      const queue = [...configs];
      const active = new Set<Promise<void>>();
      const { MAX_CONCURRENT_RESEARCHERS } = this.config;
      let lastLaunchTime = 0;

      while (queue.length > 0 || active.size > 0) {
          if (signal?.aborted) throw new Error("Research aborted.");
          while (active.size < MAX_CONCURRENT_RESEARCHERS && queue.length > 0) {
              const now = Date.now();
              const timeSinceLastLaunch = now - lastLaunchTime;
              if (lastLaunchTime > 0 && timeSinceLastLaunch < RESEARCHER_LAUNCH_DELAY_MS) {
                  await new Promise(resolve => setTimeout(resolve, RESEARCHER_LAUNCH_DELAY_MS - timeSinceLastLaunch));
              }

              const config = queue.shift()!;
              lastLaunchTime = Date.now();
              const links = linksMap.get(String(config.id)) || [];
              const histLinks = config.historicalLinks || [];
              const p = this.runResearcher(config, links, histLinks, signal)
                  .catch((err) => {
                      const errMsg = err.message || String(err);
                      logger.error(`[Orchestrator] Researcher ${config.id} failed: ${errMsg}`);
                      this.options.observer?.onResearcherFailure?.(String(config.id), errMsg);
                      recordResearcherFailure(this.options.sessionId, this.options.researchId, String(config.id));
                  })
                  .finally(() => { active.delete(p); });
              active.add(p);
          }
          if (active.size > 0) {
              await Promise.race(active);
              if (shouldStopResearch(this.options.sessionId, this.options.researchId)) {
                  for (const sess of this.activeSessions.values()) {
                      sess.abort().catch((err) => {
                          logger.warn('[Orchestrator] Failed to abort researcher session:', err);
                      });
                  }
                  throw new Error("Research stopped due to excessive infrastructure failures. Multiple researchers failed.");
              }
          }
      }
  }

  private async runResearcher(config: ResearcherConfig, initialLinks: string[], historicalUrls: string[], signal?: AbortSignal): Promise<void> {
    const id = String(config.id);
    this.options.observer?.onResearcherStart?.(id, config.name, config.goal, this.currentRound);
    metrics.increment('researchers_launched_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });

    const planningService = await this.getPlanningService();
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
        logger.warn(`[Orchestrator] Researcher ${id} has no initial search results or historical links; skipping.`);
        this.options.observer?.onResearcherComplete?.(id, '');
        return;
    }

    let evidenceSection = '';
    if (initialLinks.length > 0) {
      evidenceSection = `## Evidence Provided\nInitial search results provided the following URLs to investigate:\n${initialLinks.map(l => `- ${l}`).join('\n')}`;
    }

    const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
      .replace('{{goal}}', config.goal)
      .replace('{{store_section}}', storeSection)
      .replace('{{evidence_section}}', evidenceSection)
      .replace('{{coordination_section}}', previousQueriesSection)
      .replace('{{extra_tool_guidelines}}', '');

    logger.debug(`[Orchestrator] Researcher ${id} System Prompt:\n${prompt}`);

    const extendedCtx = this.options.ctx as unknown as ExtendedExtensionContext;
    const maxAttempts = this.config.RESEARCHER_MAX_RETRIES + 1;
    let lastError: unknown;
    const researcherExecutionStartMs = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 2), this.config.RESEARCHER_MAX_RETRY_DELAY_MS);
        logger.warn(`[Orchestrator] Researcher ${id} retry ${attempt - 1}/${this.config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
        this.options.observer?.onResearcherProgress?.(id, `Retry ${attempt - 1}...`);
        await new Promise(r => setTimeout(r, delay));
      }

      const session = await createResearcherSession({
        cwd: this.options.ctx.cwd,
        ctxModel: this.options.model,
        modelRegistry: this.options.ctx.modelRegistry,
        settingsManager: extendedCtx['settingsManager'] ?? undefined as any,
        systemPrompt: prompt,
        extensionCtx: this.options.ctx,
        noSearch: true,
        noStoredSearch: true,
        getGlobalState: (): SystemResearchState => ({
          version: 1,
          researchId: this.options.researchId,
          rootQuery: this.options.query,
          complexity: this.options.complexity,
          currentRound: 1,
          status: 'researching',
          lastUpdated: Date.now(),
          initialAgenda: [],
          allScrapedLinks: [],
          aspects: {},
        }),
        updateGlobalLinks: (links) => registerScrapedLinks(this.options.researchId, links),
        onSearchProgress: (links) => {
            this.options.observer?.onResearcherProgress?.(id, `${links} Results`);
        },
      });
      this.activeSessions.set(id, session);

      const subscription = session.subscribe((event: AgentSessionEvent) => {
          if (event.type === 'message_end') {
              const msg = event.message as unknown as ResearchMessage;
              if (msg?.['role'] !== 'assistant') return;
              const rawUsage = msg['usage'] as { cost?: { total: number } } | undefined;
              if (rawUsage) {
                  const parsed = parseTokenUsage(rawUsage);
                  const tokens = calculateTotalTokens(parsed);
                  const cost: number = rawUsage.cost?.total ?? 0;
                  if (tokens > 0 || cost > 0) {
                      metrics.increment('llm_tokens_total', tokens, { component: 'researcher', complexity: String(this.options.complexity) });
                      metrics.increment('llm_cost_total', cost, { component: 'researcher', complexity: String(this.options.complexity) });
                      // DESIGN NOTE: onResearcherProgress includes token/cost tracking.
                      // onTokensConsumed is called as an alternative interface for observers
                      // that prefer granular tracking. Implement ONE OR THE OTHER, not both.
                      this.options.observer?.onResearcherProgress?.(id, undefined, tokens, cost);
                      this.options.observer?.onTokensConsumed?.(tokens, cost);
                  }
              }
          } else if (event.type === 'tool_execution_start') {
              this.options.observer?.onResearcherProgress?.(id, `${event.toolName}`);
          } else if (event.type === 'tool_execution_end') {
              this.options.observer?.onResearcherProgress?.(id, `done:${event.toolName}`);
          }
      });

      try {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            const msg = `Researcher ${id} (${config.name}) timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`;
            session.abort().catch((err) => {
                logger.warn('[Orchestrator] Failed to abort timed-out researcher session:', err);
            }).finally(() => reject(new Error(msg)));
          }, this.config.RESEARCHER_TIMEOUT_MS);
        });

        // Keep onAbort in outer scope so the listener can be removed in finally
        // whether the race resolves via session.prompt, timeout, or abort.
        let abortCleanup: (() => void) | undefined;
        try {
          await Promise.race([
            session.prompt(`Topic: ${config.name}\nGoal: ${config.goal}\n\nPerform your research and submit your full report now.`),
            timeoutPromise,
            ...(signal ? [
              new Promise<never>((_, reject) => {
                const onAbort = () => {
                  session.abort().catch(err => logger.warn('[Orchestrator] Failed to abort session on signal:', err));
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
        metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
        logger.debug(`[Orchestrator] Researcher ${id} Final Response:\n${responseText}`);

        this.reports.set(`${this.currentRound}.${id}`, responseText);
        this.options.observer?.onResearcherComplete?.(id, responseText);
        return;
      } catch (err) {
        const researcherDuration = Date.now() - researcherExecutionStartMs;
        metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound), status: 'error' });
        metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(this.options.complexity), round: String(this.currentRound) });
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          logger.warn(`[Orchestrator] Researcher ${id} attempt ${attempt} failed: ${errMsg}; will retry`);
        } else {
          logger.error(`[Orchestrator] Researcher ${id} failed all ${maxAttempts} attempts: ${errMsg}`);
          metrics.increment('researcher_retries_exhausted_total', 1, { mode: 'deep', complexity: String(this.options.complexity) });
        }
      } finally {
        subscription();
        session.abort().catch((err) => {
            logger.warn(`[Orchestrator] Failed to abort researcher session ${id}:`, err);
        });
        this.activeSessions.delete(id);
      }
    }

    throw lastError;
  }

  private async evaluate(signal?: AbortSignal, mustSynthesize = false, planningService?: PlanningService): Promise<ResearchPlan> {
      this.options.observer?.onEvaluationStart?.(this.currentRound);
      this.options.observer?.onEvaluationProgress?.('eval');
      metrics.increment('evaluator_runs_total', 1, { complexity: String(this.options.complexity), round: String(this.currentRound) });

      // Get PlanningService if not provided
      if (!planningService) {
        planningService = await this.getPlanningService();
      }

      const previousPlan = planningService.getCurrentPlan();

      // Knowledge Store Context Injection for Evaluator
      let historicalLinksSection = '';
      if (this.config.KNOWLEDGE_STORE_ENABLED) {
        try {
          const store = await getStore();
          const historicalUrls = await store.findRelevantUrls(this.options.query, { limit: 20 });
          if (historicalUrls.length > 0) {
            historicalLinksSection = '\n\n## Historical Knowledge Store (Discovery)\n' +
              'The following relevant URLs were found in your local knowledge store. They contain summaries of findings from previous research sessions:\n\n' +
              historicalUrls.map(u => `- ${u}`).join('\n') +
              '\n\nDistribute these historical links among your newly delegated researchers for re-investigation. Researchers will retrieve a historical summary hint and the fresh full content when scraping.';
          }
        } catch (err) {
          logger.warn('[Orchestrator] Failed to fetch historical context for evaluation (non-fatal):', err);
        }
      }

      const auth = await this.options.ctx.modelRegistry.getApiKeyAndHeaders(this.options.model);
      if (!auth.ok) throw new Error(`Model auth failed: ${auth.error}`);
      logger.log(`[Orchestrator] Evaluator auth for model ${this.options.model.id}: ok=${auth.ok}, hasApiKey=${!!auth.apiKey}, headerKeys=${JSON.stringify(Object.keys(auth.headers ?? {}))}`);

      // Use PlanningService for evaluation
      const plan = await planningService.updatePlanForRound({
        currentPlan: previousPlan,
        reports: this.reports,
        round: this.currentRound,
        query: this.options.query,
        complexity: this.options.complexity,
        model: this.options.model,
        config: this.config,
        signal,
        previousPlan,
        totalResearchersPlanned: planningService.getTotalResearchersPlanned(),
        mustSynthesize,
        historicalLinksSection,
      });

      // Track observer callback
      this.options.observer?.onEvaluationDecision?.(plan.action as 'synthesize' | 'delegate', plan, this.currentRound);

      // Add new queries to history
      if (plan.allQueries && plan.allQueries.length > 0) {
        planningService.addToQueryHistory(plan.allQueries);
      }

      // Handle forced synthesis fallback
      if (mustSynthesize && plan.action !== 'synthesize') {
          logger.warn('[Orchestrator] Evaluator tried to delegate despite reaching max rounds; forcing synthesis.');
          plan.action = 'synthesize';
          // When forcing synthesis from a delegation plan, the model hasn't produced
          // a synthesis report, so we must use the fallback.
          plan.content = this.buildFallbackSynthesis();
      }

      return plan;
  }
}