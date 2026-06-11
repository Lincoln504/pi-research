/**
 * Researcher Executor
 *
 * Handles execution of individual researchers
 */

import type { ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';
import type { ExtendedExtensionContext } from '../types/extension-context.ts';
import { createResearcherSession } from './researcher.ts';
import { registerScrapedLinks } from '../utils/shared-links.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { extractUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { ServiceNames } from '../core/interfaces/service-names.ts';
import type { IResearchSynthesisService } from '../core/service-interfaces.ts';
import { getService } from '../core/service-registry.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { recordResearcherFailure, getSteeringMessages } from '../utils/session-state.ts';
import type { RunResearcherOptions } from './orchestration-types.ts';

/**
 * Run a single researcher with retries
 */
export async function runResearcher(options: RunResearcherOptions): Promise<void> {
  const {
    config: researcherConfig,
    initialLinks,
    historicalUrls,
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
    sessionId,
  } = options;
  
  const id = String(researcherConfig.id);
  observer?.onResearcherStart?.(id, researcherConfig.name, researcherConfig.goal, round);
  metrics.increment('researchers_launched_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });

  const currentPlan = planningService.getCurrentPlan(researchId);
  const previousQueriesSection = currentPlan?.allQueries && currentPlan.allQueries.length > 0
    ? `\n### Previous Queries (Sibling Researchers)\n${currentPlan.allQueries.map((q: string) => `- ${q}`).join('\n')}\n`
    : '';

  let storeSection = '';
  if (historicalUrls.length > 0) {
    storeSection = '\n## Knowledge Store\n' +
      'The following URLs were found in the knowledge store from previous research sessions. ' +
      'Scrape each URL to retrieve its full current content. The summary below describes what was previously found at that URL — use it as a guide for what to expect.\n' +
      historicalUrls.map(e => `- ${e.url}\n  Previous summary: ${e.description}`).join('\n');
  }

  const researcherPromptTemplate = loadPrompt('researcher', '..');
  if (initialLinks.length === 0 && historicalUrls.length === 0) {
    logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results or historical links; skipping.`);
    // FIX (New Issue C): Record as a partial failure rather than silently skipping,
    // so the orchestration layer knows coverage was reduced.
    recordResearcherFailure((ctx as ExtendedExtensionContext).sessionId, researchId, id);
    metrics.increment('researcher_skipped_total', 1, { mode: 'deep', complexity: String(complexity), reason: 'no_initial_links' });
    // Notify failure (not completion) since coverage was reduced
    observer?.onResearcherFailure?.(id, 'No initial search results or historical links available');
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

  logger.debug(`[ResearcherExecutor] Researcher ${id} System Prompt:\n${prompt}`);

  const extendedCtx = ctx as unknown as ExtendedExtensionContext;
  const maxAttempts = config.RESEARCHER_MAX_RETRIES + 1;
  let lastError: unknown;
  const researcherExecutionStartMs = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
      logger.warn(`[ResearcherExecutor] Researcher ${id} retry ${attempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
      observer?.onResearcherProgress?.(id, 'retry');
      await new Promise(r => setTimeout(r, delay));
    }

    const workerExclude = ['search'];
    const mergedExclude = [...new Set([...workerExclude, ...(options.excludeTools || [])])];

    const session = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      settingsManager: extendedCtx['settingsManager'],
      systemPrompt: prompt,
      extensionCtx: ctx,
      excludeTools: mergedExclude,
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
        observer?.onResearcherProgress?.(id, `${links} results`);
      },
      onUrlScrapeResult: (_url, success) => {
        observer?.onToolResult?.(id, success);
      },
    });

    const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE);
    sessionService.registerSession(researchId, id, session, () => session.abort().catch((err) => logger.warn('[ResearcherExecutor] Session abort failed:', err)));

    const deliveredSteeringIds = new Set<string>();
    let lastSteeringCheck = Date.now();

    const subscription = session.subscribe((event: any) => {
      // Check for new steering messages periodically
      const now = Date.now();
      if (now - lastSteeringCheck > 500) {
        lastSteeringCheck = now;
        const allSteering = getSteeringMessages(sessionId);
        for (const msg of allSteering) {
          if (!deliveredSteeringIds.has(msg.id)) {
            deliveredSteeringIds.add(msg.id);
            session.steer(msg.text).catch(e => logger.warn('[ResearcherExecutor] Failed to deliver steering:', e));
            logger.debug(`[ResearcherExecutor] Delivered mid-flight steering message to ${id}: ${msg.text}`);
          }
        }
      }

      if (event.type === 'message_update') {
        const ame = event.assistantMessageEvent as any;
        if (ame?.type === 'start') {
          const inputTokens: number = ame.partial?.usage?.input ?? 0;
          if (inputTokens > 0) {
            observer?.onResearcherTokensHint?.(id, inputTokens);
          }
        }
      } else if (event.type === 'message_end') {
        const msg = event.message as unknown as ResearchMessage;
        if (msg?.['role'] !== 'assistant') return;

        // Log thinking content if present
        const content = msg['content'];
        if (Array.isArray(content)) {
            const thinking = content.find(c => c.type === 'thinking');
            if (thinking?.thinking) {
                logger.debug(`[ResearcherExecutor] Researcher ${id} Thinking:\n${thinking.thinking}`);
            }
        }

        const rawUsage = msg['usage'] as any;
        if (rawUsage) {
          const { tokens, cost } = extractUsage(model, rawUsage);

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
        // Per-tool flash for non-scrape tools (scrape uses per-URL callback instead)
        if (event.toolName !== 'scrape') {
          observer?.onToolResult?.(id, !event.isError);
        }
      }
    });

    try {
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          const msg = `Researcher ${id} (${researcherConfig.name}) timed out after ${config.RESEARCHER_TIMEOUT_MS}ms`;
          session.abort().catch((err) => {
            logger.warn('[ResearcherExecutor] Failed to abort timed-out researcher session:', err);
          }).finally(() => reject(new Error(msg)));
        }, config.RESEARCHER_TIMEOUT_MS);
      });

      let abortCleanup: (() => void) | undefined;
      try {
        const promptPromise = session.prompt(`Topic: ${researcherConfig.name}\nGoal: ${researcherConfig.goal}\n\nPerform your research and submit your full report now.`);
        promptPromise.catch((err: Error) => logger.debug(`[ResearcherExecutor] Background session prompt rejection: ${err.message}`));
        await Promise.race([
          promptPromise,
          timeoutPromise,
          ...(signal ? [
            new Promise<never>((_, reject) => {
              const onAbort = () => {
                session.abort().catch(err => logger.warn('[ResearcherExecutor] Failed to abort session on signal:', err));
                reject(new Error('Aborted'));
              };
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener('abort', onAbort);
              }
            })
          ] : []),
        ]);
      } finally {
        clearTimeout(timeoutId);
        abortCleanup?.();
      }

      const responseText = ensureAssistantResponse(session, id);
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round) });
      logger.debug(`[ResearcherExecutor] Researcher ${id} Final Response:\n${responseText}`);

      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE);
      synthesisService.storeReport(researchId, `${round}.${id}`, responseText);

      observer?.onResearcherComplete?.(id, responseText);
      return;
    } catch (err) {
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round), status: 'error' });
      metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      
      if (signal?.aborted || errMsg === 'Aborted') {
        logger.debug(`[ResearcherExecutor] Researcher ${id} was aborted, skipping retries.`);
        break; // Break out of the attempt loop
      }

      if (attempt < maxAttempts) {
        logger.warn(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} failed: ${errMsg}; will retry`);
      } else {
        logger.error(`[ResearcherExecutor] Researcher ${id} failed all ${maxAttempts} attempts: ${errMsg}`);
        metrics.increment('researcher_retries_exhausted_total', 1, { mode: 'deep', complexity: String(complexity) });
      }
    } finally {
      subscription();
      await session.abort().catch((err) => {
        logger.warn(`[ResearcherExecutor] Failed to abort researcher session ${id}:`, err);
      });
      sessionService.unregisterSession(researchId, id);
    }
  }

  throw lastError;
}
