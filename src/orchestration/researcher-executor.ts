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
import { ServiceNames,
  type IResearchSynthesisService,
} from '../core/service-interfaces.ts';
import { getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import { loadPrompt } from '../core/llm/prompts.ts';
import { injectCurrentDate } from '../core/llm/inject-date.ts';
import { recordResearcherFailure, getSteeringMessages } from './session/session-state.ts';
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
  const container = tryGetServiceContainerFromCtx(ctx);
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

  const researcherPromptTemplate = loadPrompt('researcher');
  if (initialLinks.length === 0 && historicalUrls.length === 0) {
    logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results or historical links; skipping.`);
    recordResearcherFailure((ctx as ExtendedExtensionContext).sessionId, researchId, id);
    metrics.increment('researcher_skipped_total', 1, { mode: 'deep', complexity: String(complexity), reason: 'no_initial_links' });
    observer?.onResearcherFailure?.(id, 'No initial search results or historical links available');
    return;
  }

  let evidenceSection = '';
  if (initialLinks.length > 0) {
    evidenceSection = `## Evidence Provided\nInitial search results provided the following URLs to investigate:\n${initialLinks.map(l => `- ${l}`).join('\n')}`;
  }

  const maxAttempts = config.RESEARCHER_MAX_RETRIES + 1;
  let lastError: unknown;
  const researcherExecutionStartMs = Date.now();
  const deliveredSteeringIds = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
      logger.warn(`[ResearcherExecutor] Researcher ${id} retry ${attempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
      observer?.onResearcherProgress?.(id, 'retry');
      await new Promise(r => setTimeout(r, delay));
    }

    // Generate prompt for this attempt, incorporating ALL steering messages delivered so far
    const allSteering = getSteeringMessages(sessionId);
    let steeringSection = '';
    if (allSteering.length > 0) {
        steeringSection = '\n\n### ADDITIONAL USER GUIDANCE (Mandatory directional rules for your research)\n' +
            allSteering.map(m => {
                deliveredSteeringIds.add(m.id);
                return `- ${m.text}`;
            }).join('\n');
    }

    const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
      .replace('{{goal}}', researcherConfig.goal)
      .replace('{{store_section}}', storeSection)
      .replace('{{evidence_section}}', evidenceSection)
      .replace('{{coordination_section}}', previousQueriesSection)
      .replace('{{extra_tool_guidelines}}', '')
      .trim() + steeringSection;

    logger.debug(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} System Prompt:\n${prompt}`);

    const workerExclude = ['search'];
    const mergedExclude = [...new Set([...workerExclude, ...(options.excludeTools || [])])];

    const { session, resolvedModel } = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      systemPrompt: prompt,
      extensionCtx: ctx,
      excludeTools: mergedExclude,
      researcherId: id,
      getGlobalState: (): SystemResearchState => ({
        version: 1,
        researchId,
        rootQuery: query,
        complexity,
        currentRound: round,
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

    const sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
    sessionService.registerSession(researchId, id, session, () => session.abort().catch((err) => logger.warn('[ResearcherExecutor] Session abort failed:', err)));

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

        const rawUsage = msg['usage'] as any;
        if (rawUsage) {
          const { tokens, cost } = extractUsage(resolvedModel, rawUsage);

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

      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      synthesisService.storeReport(researchId, `${round}.${id}`, responseText);

      observer?.onResearcherComplete?.(id, responseText);
      return;
    } catch (err) {
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round), status: 'error' });
      metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Attempt to salvage partial content on timeout or error
      try {
        const partialResponse = ensureAssistantResponse(session, id);
        if (partialResponse && partialResponse.trim().length > 50) {
          const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          synthesisService.storeReport(researchId, `${round}.${id}`, partialResponse + '\n\n---\n*⚠ This report was truncated due to a timeout/error. Content may be incomplete.*');
          logger.log(`[ResearcherExecutor] Researcher ${id} salvaged partial content (${partialResponse.length} chars) after error: ${errMsg}`);
          observer?.onResearcherComplete?.(id, partialResponse);
          return;
        }
      } catch (salvageErr) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} salvage attempt failed:`, salvageErr);
      }
      
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

      // Restore the default thinking label now that the researcher is done.
      // Otherwise "Researcher X" persists for all subsequent agent turns.
      if (ctx.hasUI && typeof ctx.ui.setHiddenThinkingLabel === 'function') {
        ctx.ui.setHiddenThinkingLabel();
      }
    }
  }

  throw lastError;
}
