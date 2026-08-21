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
import { recordLlmUsage } from '../utils/llm-usage.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { ServiceNames,
  type IResearchSynthesisService,
} from '../core/service-interfaces.ts';
import { getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import { loadPrompt } from '../core/llm/prompts.ts';
import { injectCurrentDate } from '../core/llm/inject-date.ts';
import { recordResearcherFailure, getSteeringMessages, shouldStopResearch } from './session-state.ts';
import { isAbortSentinel, boundSessionAbort } from './abort-utils.ts';
import type { RunResearcherOptions } from './orchestration-types.ts';
import { search } from '../web-research/search.ts';
import { RESEARCHER_DIGEST_SECTION } from '../utils/coverage-digest.ts';

/**
 * Failures a retry cannot fix, because the next attempt sends the same request to
 * the same account and gets the same answer.
 *
 * Deliberately narrow. The retry loop is otherwise unclassified and that is mostly
 * FINE — the log history says so. Across 53 days the loop retried 126 attempts:
 * "produced no text output" recovered 26/26; a provider rejecting
 * `reasoning_effort: 'none'` recovered ~18/19, because OpenRouter routes the same
 * model to different upstream providers per request and only some reject it;
 * token-limit truncation recovered ~16/17. Classifying any of those as permanent
 * would break runs that currently succeed.
 *
 * Insufficient credits is the one class with no recoveries at all: 30 retried
 * attempts, every one belonging to an episode that went on to exhaust, 0 of 10
 * recovered. Those ten cost five runs their entire output — searches already paid
 * for, 70 results collected and discarded, and a synthesis call billed over an
 * empty corpus before the run threw. The account balance does not change in the
 * two seconds between attempts.
 *
 * Note what this does NOT cover: a researcher timeout retries and recovers ~88% of
 * the time, so it stays retriable even though three attempts at a 15-minute budget
 * cost 45 minutes of wall clock. That cost is real and worth addressing, but by
 * bounding total retry time rather than by refusing the retry that usually works.
 */
export function isUnretriableResearcherError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Matched on the provider's wording rather than a bare "402": a status code can
  // appear inside an unrelated payload (a token count, a URL, a quoted response
  // body), and this gate ends a researcher's run — it must not fire on a
  // coincidence. Same reasoning as isTransientSynthesisError's boundary anchoring.
  return message.includes('requires more credits')
    || message.includes('insufficient credits')
    || message.includes('insufficient_quota');
}

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

  // Fast-stop self-check: when the run's failure threshold trips, runResearchers'
  // fast-stop path aborts only REGISTERED sessions — a researcher that is still
  // acquiring initial links, sleeping between attempts, or rebuilding a session
  // has none, and would otherwise sail on into a full LLM session + scrape burst
  // AFTER the run already returned and released its run-cap slot. Every launch /
  // retry boundary below consults this and exits quietly instead (the stop error
  // is the run's outcome, not this researcher's failure).
  const stopRequested = (): boolean => shouldStopResearch(sessionId, researchId, config.MAX_FAILED_RESEARCHERS);
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

  let effectiveInitialLinks = initialLinks;
  if (effectiveInitialLinks.length === 0 && historicalUrls.length === 0) {
    // The plan-wide initial search burst (run once, before any researcher starts)
    // can come back empty for THIS researcher's queries specifically because the
    // shared browser pool was mid-recovery (e.g. leader-election churn, see
    // task-execution-service.ts) at that exact moment — not because the topic has
    // no results. Unlike every other researcher failure mode, this one used to
    // `return` immediately, bypassing RESEARCHER_MAX_RETRIES entirely: a single
    // transient pool hiccup counted as a full, unretried researcher failure and,
    // combined with MAX_FAILED_RESEARCHERS, could abort a run with several other
    // researchers still healthy and in flight. Give it the same bounded retry
    // budget as the rest of this function, re-issuing a fresh search for this
    // researcher's own queries before giving up.
    const retryQueries = researcherConfig.queries?.length ? researcherConfig.queries : [researcherConfig.goal];
    const maxLinkAttempts = config.RESEARCHER_MAX_RETRIES + 1;
    for (let linkAttempt = 1; linkAttempt <= maxLinkAttempts && effectiveInitialLinks.length === 0; linkAttempt++) {
      if (linkAttempt > 1) {
        if (signal?.aborted || container?.isDisposing || stopRequested()) break;
        const delay = Math.min(1000 * Math.pow(2, linkAttempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
        logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results; retry ${linkAttempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
        // Abortable, like every sibling sleep in this file (attempt backoff
        // below, stagger in runResearchers): a plain setTimeout held a cancel
        // hostage for up to RESEARCHER_MAX_RETRY_DELAY_MS. The loop-top
        // abort/stop check right after this resolves handles the early wake.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          const onAbort = () => { clearTimeout(timer); resolve(); };
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
      if (signal?.aborted || container?.isDisposing || stopRequested()) break;
      try {
        const queryResults = await search(retryQueries, config, signal, undefined, container);
        const urls = new Set<string>();
        for (const qr of queryResults) {
          for (const r of qr.results || []) urls.add(r.url);
        }
        effectiveInitialLinks = [...urls];
      } catch (err) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} link-retry search burst failed:`, err);
      }
    }

    // A cancel/teardown/fast-stop lands here with zero links because the loop
    // above breaks on abort/disposal/stop — that is a clean stop, not a "search
    // produced nothing" researcher failure. Return quietly (mirrors the
    // cancellation treatment in runResearchers) instead of recording a failure,
    // bumping the skip metric, and painting a red failed slice with a bogus root
    // cause on a plain cancel.
    if (signal?.aborted || container?.isDisposing || stopRequested()) {
      logger.debug(`[ResearcherExecutor] Researcher ${id} cancelled while acquiring initial links; skipping quietly.`);
      return;
    }

    if (effectiveInitialLinks.length === 0) {
      logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results or historical links after ${maxLinkAttempts} attempt(s); skipping.`);
      // Use the resolved sessionId (= piSessionId), NOT the raw ctx.sessionId: when
      // ctx.sessionId is unset but sessionManager supplies a real id (common in SDK
      // use), recording under ctx.sessionId would file this no-links skip under a
      // different id than shouldStopResearch() checks, so the fast-stop guard would
      // under-count exactly the broad-search-failure case it exists to catch.
      recordResearcherFailure(sessionId, researchId, id, 'no initial search results or historical links (search produced nothing usable)');
      metrics.increment('researcher_skipped_total', 1, { mode: 'deep', complexity: String(complexity), reason: 'no_initial_links' });
      observer?.onResearcherFailure?.(id, 'No initial search results or historical links available');
      return;
    }
  }

  let evidenceSection = '';
  if (effectiveInitialLinks.length > 0) {
    evidenceSection = `## Evidence Provided\nInitial search results provided the following URLs to investigate:\n${effectiveInitialLinks.map(l => `- ${l}`).join('\n')}`;
  }

  const maxAttempts = config.RESEARCHER_MAX_RETRIES + 1;
  let lastError: unknown;
  const researcherExecutionStartMs = Date.now();
  const deliveredSteeringIds = new Set<string>();

  // The system prompt is deliberately invariant across researchers, rounds, AND
  // retry attempts: everything per-researcher (goal, knowledge-store results,
  // initial evidence, sibling coordination, steering) is delivered in the initial
  // USER message instead. A byte-identical system prompt + tool set is the
  // cacheable prefix providers key on, so every researcher after the first gets a
  // prompt-cache read on that prefix rather than a fresh write. Built once, out
  // of the retry loop, because nothing in it varies per attempt.
  const researcherSystemPrompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
    .replace('{{extra_tool_guidelines}}', '')
    // Function replacer so `$`-bearing content is inserted literally, not as a
    // String.replace substitution pattern.
    .replace('{{digest_section}}', () => RESEARCHER_DIGEST_SECTION)
    .trim();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Launch boundary: never build a session for a run that is already cancelled
    // or fast-stopped. The abort sentinel keeps the wrapper's clean-cancel
    // classification (runResearchers treats it exactly like the race's throw);
    // the fast-stop exit is quiet — see stopRequested above.
    if (signal?.aborted) throw new Error('Aborted');
    if (stopRequested()) {
      logger.debug(`[ResearcherExecutor] Researcher ${id} exiting before attempt ${attempt}: fast-stop threshold crossed.`);
      return;
    }
    if (attempt > 1) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 2), config.RESEARCHER_MAX_RETRY_DELAY_MS);
      logger.warn(`[ResearcherExecutor] Researcher ${id} retry ${attempt - 1}/${config.RESEARCHER_MAX_RETRIES} after ${delay}ms`);
      observer?.onResearcherProgress?.(id, 'retry');
      // Abortable: a cancel during this backoff must wake the sleep immediately —
      // an inert setTimeout held the loop for up to RESEARCHER_MAX_RETRY_DELAY_MS
      // after the cancel and then re-entered a full attempt (fresh session +
      // billed prompt). Mirrors the stagger sleep in runResearchers.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, delay);
        const onAbort = () => { clearTimeout(timer); resolve(); };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      // Re-launch boundary after the sleep: a cancel, fast-stop, or container
      // teardown landing DURING the backoff must not re-enter a full attempt —
      // this is exactly the window the fast-stop path cannot reach, because
      // abortAllSessions only aborts registered sessions and a between-attempts
      // researcher has none.
      if (signal?.aborted) throw new Error('Aborted');
      if (stopRequested() || container?.isDisposing) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} exiting after backoff: fast-stop or container teardown.`);
        return;
      }
    }

    // Build this attempt's initial USER message: the researcher's assignment plus
    // every per-researcher section that used to live in the system prompt (goal,
    // knowledge-store results, initial evidence, sibling coordination), and ALL
    // steering messages delivered so far. Rebuilt per attempt so a retry picks up
    // steering that arrived between attempts; the system prompt above never changes.
    const allSteering = getSteeringMessages(sessionId);
    let steeringSection = '';
    if (allSteering.length > 0) {
        steeringSection = '### ADDITIONAL USER GUIDANCE (Mandatory directional rules for your research)\n' +
            allSteering.map(m => {
                deliveredSteeringIds.add(m.id);
                return `- ${m.text}`;
            }).join('\n');
    }

    const userMessage = [
      `Topic: ${researcherConfig.name}\nGoal: ${researcherConfig.goal}`,
      storeSection.trim(),
      evidenceSection.trim(),
      previousQueriesSection.trim(),
      steeringSection,
      'Perform your research and submit your full report now.',
    ].filter(Boolean).join('\n\n');

    logger.debug(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} System Prompt:\n${researcherSystemPrompt}\n\nUser Message:\n${userMessage}`);

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
      systemPrompt: researcherSystemPrompt,
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

    // Post-registration self-check: this session is now visible to
    // abortAllSessions(), but that scan is point-in-time — a stop/cancel that
    // landed anywhere between createResearcherSession() resolving and
    // registerSession() actually running (the `await getService(...)` above can
    // yield the event loop) would have missed this session entirely, and every
    // other guard in this function only fires BEFORE session creation or
    // BETWEEN attempts. Nothing between here and session.prompt() below awaits
    // anything, so this single check closes the whole window: either it fires
    // here, or the run is not stopping and prompt() is about to make this
    // session's registration meaningful. Mirrors the top-of-loop launch
    // boundary above exactly (signal throws, fast-stop returns quietly) —
    // deliberately NOT container?.isDisposing: like that boundary, this is
    // still attempt 1's launch, and a disposing container must let this
    // attempt's own session.prompt() fail naturally into the catch block's
    // disposal classification rather than being pre-empted here.
    if (signal?.aborted || stopRequested()) {
      logger.debug(`[ResearcherExecutor] Researcher ${id} exiting right after session creation: fast-stop/cancel landed before prompt() was reached.`);
      await boundSessionAbort(
        session.abort().catch((err) => logger.warn(`[ResearcherExecutor] Failed to abort researcher session ${id} on post-creation fast-stop:`, err)),
        () => logger.warn(`[ResearcherExecutor] Researcher ${id} session abort did not settle within 10s; continuing cleanup`),
      );
      sessionService.unregisterSession(researchId, id);
      if (signal?.aborted) throw new Error('Aborted');
      return;
    }

    let lastSteeringCheck = Date.now();

    // User-supplied observer callbacks (SDK consumers) are invoked from inside
    // session event dispatch — a throw there would propagate into the session's
    // event loop. Isolate them the way TuiPulse isolates its subscribers.
    const safeObserve = (fn: () => void): void => {
      try { fn(); } catch (err) { logger.debug('[ResearcherExecutor] Observer callback threw:', err); }
    };

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
            safeObserve(() => observer?.onResearcherTokensHint?.(id, inputTokens));
          }
        }
      } else if (event.type === 'message_end') {
        const msg = event.message as unknown as ResearchMessage;
        if (msg?.['role'] !== 'assistant') return;

        const rawUsage = msg['usage'] as any;
        if (rawUsage) {
          // Observer exceptions must not kill the researcher, so hand recordLlmUsage
          // a safeObserve-wrapped sink rather than the raw observer.
          const { tokens, cost } = recordLlmUsage(resolvedModel, rawUsage, {
            component: 'researcher',
            complexity,
            observer: { onTokensConsumed: (t, c) => safeObserve(() => observer?.onTokensConsumed?.(t, c)) },
          });
          if (tokens > 0 || cost > 0) {
            safeObserve(() => observer?.onResearcherProgress?.(id, undefined, tokens, cost));
          }
        }
      } else if (event.type === 'tool_execution_start') {
        safeObserve(() => observer?.onResearcherProgress?.(id, `${event.toolName}`));
      } else if (event.type === 'tool_execution_end') {
        safeObserve(() => observer?.onResearcherProgress?.(id, `done:${event.toolName}`));
        // Per-tool flash for non-scrape tools (scrape uses per-URL callback instead)
        if (event.toolName !== 'scrape') {
          safeObserve(() => observer?.onToolResult?.(id, !event.isError));
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
          // Reject FIRST, abort as fire-and-forget cleanup: session.abort() awaits the
          // in-flight request, which is the very thing that is stuck (e.g. a provider
          // retry loop against an exhausted quota) — gating the rejection on it settling
          // makes the timeout ineffective exactly when it is needed.
          session.abort().catch((err) => {
            logger.warn('[ResearcherExecutor] Failed to abort timed-out researcher session:', err);
          });
          reject(new Error(msg));
        }, config.RESEARCHER_TIMEOUT_MS);
      });

      let abortCleanup: (() => void) | undefined;
      try {
        const promptPromise = session.prompt(userMessage);
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
        // Do NOT retry an ungrounded report when the run is being torn down (quit/SIGTERM sets
        // container.isDisposing without necessarily aborting the signal). A retry rebuilds the
        // session and relaunches a search/scrape burst into a WorkerPool that dispose() is
        // destroying — the same "Cannot execute a task on destroying pool" storm the catch-block
        // guard prevents. This branch exits via `continue`, so it needs the guard too.
        if (signal?.aborted || container?.isDisposing) {
          logger.debug(`[ResearcherExecutor] Researcher ${id} ungrounded but run aborting/disposing; skipping retries.`);
          break;
        }
        logger.warn(`[ResearcherExecutor] Researcher ${id} attempt ${attempt}/${maxAttempts} ungrounded (scrape enabled, 0 successful scrapes, 0 security/stackexchange grounding hits, no knowledge-store grounding); ${attempt < maxAttempts ? 'retrying' : 'failing'}`);
        continue;
      }

      const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
      synthesisService.storeReport(researchId, `${round}.${id}`, responseText);

      // Emit what was STORED, not what the model returned: storeReport splits the coverage
      // digest off the head of the report, and the SDK's `researcher_complete` event should
      // carry the report a consumer would get from the run, not the routing metadata that
      // was stripped out of it.
      observer?.onResearcherComplete?.(id, synthesisService.getReport(researchId, `${round}.${id}`) ?? responseText);
      return;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      // Computed up front (not just at the retry-skip check below) so the
      // metrics right after don't mislabel a clean cancellation as an error.
      // The sentinel has TWO forms (see the retry-skip check's own comment);
      // isAbortSentinel matches both.
      const tornDown = Boolean(signal?.aborted || isAbortSentinel(errMsg) || errMsg.includes('during container disposal') || container?.isDisposing);
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round), status: tornDown ? 'cancelled' : 'error' });
      // A clean cancellation/teardown is not a researcher fault — mirrors
      // quick-research-orchestrator's equivalent catch, which computes this
      // same distinction before touching its own error-only counters.
      if (!tornDown) {
        metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
      }

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
          // As on the success path: emit the stored body, with the digest already split off.
          observer?.onResearcherComplete?.(id, synthesisService.getReport(researchId, `${round}.${id}`) ?? partialResponse);
          return;
        }
      } catch (salvageErr) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} salvage attempt failed:`, salvageErr);
      }
      
      // Skip retries when the run is being torn down: an aborted signal, the abort
      // sentinel, or the service container entering disposal (SIGTERM/quit mid-run,
      // which throws "…during container disposal" from getService). The sentinel has
      // TWO forms — the race's bare 'Aborted' above AND the '<id>: Aborted' that
      // ensureAssistantResponse throws when a fast-stop abortAllSessions() aborted
      // this session externally (prompt() then resolves normally) — so match it via
      // isAbortSentinel, not exact equality: the prefixed form used to slip past
      // this guard and RETRY a researcher the fast-stop path had just aborted.
      // Retrying during disposal is futile — services are being destroyed — and it
      // relaunches search bursts into a WorkerPool that dispose() is simultaneously
      // destroying, producing a storm of "Cannot execute a task on destroying pool"
      // errors. (tornDown computed above, alongside the metrics it also gates.)
      if (tornDown) {
        logger.debug(`[ResearcherExecutor] Researcher ${id} aborted or container disposing, skipping retries.`);
        break; // Break out of the attempt loop
      }

      // A failure the account cannot retry its way out of. Spending the remaining
      // attempts changes nothing except how long the user waits for the same answer,
      // and it buries the real cause under three duplicate warnings.
      if (isUnretriableResearcherError(err)) {
        logger.error(`[ResearcherExecutor] Researcher ${id} failed with an unretriable provider error, not retrying: ${errMsg}`);
        metrics.increment('researcher_unretriable_total', 1, { mode: 'deep', complexity: String(complexity) });
        break;
      }

      if (attempt < maxAttempts) {
        logger.warn(`[ResearcherExecutor] Researcher ${id} attempt ${attempt} failed: ${errMsg}; will retry`);
      } else {
        logger.error(`[ResearcherExecutor] Researcher ${id} failed all ${maxAttempts} attempts: ${errMsg}`);
        metrics.increment('researcher_retries_exhausted_total', 1, { mode: 'deep', complexity: String(complexity) });
      }
    } finally {
      subscription();
      // Bounded: after a timeout, session.abort() awaits the very in-flight request
      // that is stuck (e.g. a provider retry loop against an exhausted quota) and may
      // never settle — never let per-attempt cleanup hang the retry loop on it. The
      // retry builds a fresh session; the abandoned abort keeps draining in the
      // background and its session dies with the run's teardown.
      await boundSessionAbort(
        session.abort().catch((err) => {
          logger.warn(`[ResearcherExecutor] Failed to abort researcher session ${id}:`, err);
        }),
        () => logger.warn(`[ResearcherExecutor] Researcher ${id} session abort did not settle within 10s; continuing cleanup`),
      );
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
