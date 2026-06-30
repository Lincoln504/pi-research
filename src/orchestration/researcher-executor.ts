/**
 * Researcher Executor
 *
 * Handles execution of individual researchers
 */

import type { ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';
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
import { recordResearcherFailure, getSteeringMessages } from './session-state.ts';
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
    // Use the resolved sessionId (= piSessionId), NOT the raw ctx.sessionId: when
    // ctx.sessionId is unset but sessionManager supplies a real id (common in SDK
    // use), recording under ctx.sessionId would file this no-links skip under a
    // different id than shouldStopResearch() checks, so the fast-stop guard would
    // under-count exactly the broad-search-failure case it exists to catch.
    recordResearcherFailure(sessionId, researchId, id);
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

    // Grounding gate: when the scrape tool is enabled for this researcher, a report grounded in
    // NO real source (and no knowledge-store summaries to fall back on) is ungrounded.
    // A researcher is grounded when it retrieved real content from any content-retrieval tool:
    //   - successfulScrapeCount: successes the scrape tool reports (fresh fetches AND cache hits)
    //     via the onUrlScrapeResult callback below. youtube_transcript routes its per-video
    //     successes through the SAME callback, so transcript fetches count here too.
    //   - nonScrapeGroundingHits: real items returned by the non-URL grounding tools
    //     (security_search, stackexchange), reported uniformly as details.groundingHits on the
    //     tool_execution_end event. (grep is local code search, not a web-research source, and
    //     wraps an opaque SDK result, so it is intentionally NOT a grounding signal.)
    //   - historicalUrls: knowledge-store summaries supplied to this researcher.
    // Per-attempt: each retry builds a fresh session, so both counts reset at the top of the body.
    //
    // The gate is a PRODUCTION guard against ungrounded real research. It does not apply when
    // scraping is mocked: PI_RESEARCH_MOCK_SCRAPE (a TEST-ONLY mode, not a product feature)
    // serves a tiny stub that never passes content validation, so there are zero real scrapes
    // by design — applying the gate there would fail every researcher even with a capable model
    // (which is exactly what made mocked demo/test runs look like "the model can't research").
    const scrapeEnabled = !mergedExclude.includes('scrape') && process.env['PI_RESEARCH_MOCK_SCRAPE'] !== 'true';
    let successfulScrapeCount = 0;
    let nonScrapeGroundingHits = 0;

    const { session, resolvedModel } = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      systemPrompt: prompt,
      extensionCtx: ctx,
      excludeTools: mergedExclude,
      researcherId: id,
      config,
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
        if (success) successfulScrapeCount++;
        observer?.onToolResult?.(id, success);
      },
    });

    // Hand the freshly-created AgentSession to the cleanup machinery before any
    // other work. createResearcherSession() above already allocated a live
    // session; if resolving/registering the session service throws (container
    // disposed mid-run, race), the session is not yet owned by
    // cleanupResearchServices and would leak unaborted. Abort it directly on any
    // failure in this window, then rethrow. (Same acquire-before-teardown-wired
    // class as the ghost-panel fix.)
    // Undefined until the registration below succeeds: if getService throws, the
    // finally must NOT dereference it (that TypeError would mask the real error).
    let sessionService: ResearchSessionService | undefined;
    try {
      sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
      sessionService.registerSession(researchId, id, session, () => session.abort().catch((err) => logger.warn('[ResearcherExecutor] Session abort failed:', err)));
    } catch (registrationError) {
      await session.abort().catch(() => { /* best-effort: session is being discarded */ });
      throw registrationError;
    }

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
        // Grounding accumulation for the non-URL grounding tools. They don't go through
        // onUrlScrapeResult, so they report how many real items they retrieved via a uniform
        // details.groundingHits field (e.g. security_search = vulnerabilities found,
        // stackexchange = questions/answers returned). Soft-failures (rate-limit, API error,
        // empty result) omit it or report 0, so they correctly do NOT count as grounding.
        const details = (event.result as { details?: { groundingHits?: unknown } } | undefined)?.details;
        const hits = details?.groundingHits;
        if (typeof hits === 'number' && hits > 0) {
          nonScrapeGroundingHits += hits;
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

      // Grounding gate (see scrapeEnabled / successfulScrapeCount above). A deep researcher
      // cannot search (workerExclude = ['search']); scrape is its only path to real sources.
      // If scrape was available but produced zero successful fetches AND no knowledge-store
      // summaries were supplied (historicalUrls), the report is not grounded in any source —
      // do NOT land it. Retry first (a transiently blocked scrape may recover); on the final
      // attempt this falls through to `throw lastError`, which runResearchers catches and
      // records as a researcher failure (same contract as retry-exhaustion).
      if (scrapeEnabled && successfulScrapeCount === 0 && nonScrapeGroundingHits === 0 && historicalUrls.length === 0) {
        lastError = new Error(`Researcher ${id} produced an ungrounded report: scrape tool enabled but zero successful scrapes and no other grounding`);
        metrics.increment('researcher_ungrounded_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
        logger.warn(`[ResearcherExecutor] Researcher ${id} attempt ${attempt}/${maxAttempts} ungrounded (scrape enabled, 0 successful scrapes, 0 security/stackexchange grounding hits, no knowledge-store grounding); ${attempt < maxAttempts ? 'retrying' : 'failing'}`);
        continue;
      }

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
        // Apply the same grounding gate to salvaged partials: a timed-out/errored researcher
        // with zero successful scrapes, zero non-scrape grounding hits, and no knowledge-store
        // grounding has nothing real to land, so skip the salvage store and fall through to the
        // retry/abort handling below.
        const ungrounded = scrapeEnabled && successfulScrapeCount === 0 && nonScrapeGroundingHits === 0 && historicalUrls.length === 0;
        if (partialResponse && partialResponse.trim().length > 50 && !ungrounded) {
          const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          synthesisService.storeReport(researchId, `${round}.${id}`, partialResponse + '\n\n---\n*WARNING: This report was truncated due to a timeout/error. Content may be incomplete.*');
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
      sessionService?.unregisterSession(researchId, id);

      // Restore the default thinking label now that the researcher is done.
      // Otherwise "Researcher X" persists for all subsequent agent turns.
      // Symmetric with where the label is set (researcher.ts): a no-op in the
      // research TUI, where the label is never applied in the first place.
      if (ctx.mode !== 'tui' && ctx.hasUI && typeof ctx.ui.setHiddenThinkingLabel === 'function') {
        ctx.ui.setHiddenThinkingLabel();
      }
    }
  }

  throw lastError;
}
