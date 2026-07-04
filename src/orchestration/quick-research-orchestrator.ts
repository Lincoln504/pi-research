/**
 * Quick Research Orchestrator
 *
 * Implements the single-agent research loop.
 * Optimized for speed and efficiency for simple queries.
 */

import { 
    type ExtensionContext, 
    type AgentSessionEvent,
    type AgentToolResult,
} from '@earendil-works/pi-coding-agent';
import { type Model } from '@earendil-works/pi-ai';
import { injectCurrentDate } from '../core/llm/inject-date.ts';
import { loadPrompt } from '../core/llm/prompts.ts';
import { extractUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { createResearcherSession } from './researcher.ts';
import { ensureAssistantResponse, parseCitations } from '../utils/text-utils.ts';
import { getMaxScrapeBatches } from '../constants.ts';
import type { ResearchObserver } from '../core/interfaces/observer-interfaces.ts';
import { HeadlessObserver, makeSafeObserver, type HeadlessObserverOptions } from './headless-observer.ts';
import { getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { ServiceNames, type IWriterQueue, type IKnowledgeStoreService, type IResearchSynthesisService, type IResearchOrchestration } from '../core/service-interfaces.ts';
import type { ResearchSessionService } from './research-session-service.ts';
import { normalizeUrl, registerScrapedLinks, getCachedScrapedContent } from '../utils/shared-links.ts';
import { runHealthCheck, isBusyPoolHealthFailure } from '../healthcheck/index.ts';
import { metrics } from '../utils/metrics.ts';
import { getSteeringMessages, consumeQueuedMessages, getActiveSteeringMessages } from './session-state.ts';
import type { ResearchMessage } from '../types/index.ts';
import type { SystemResearchState } from './deep-research-types.ts';

export interface QuickResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver | HeadlessObserverOptions;
  onUpdate?: (update: AgentToolResult<any>) => void;
  config?: Config;
  excludeTools?: string[];
  initialLinks?: string[];
}

export class QuickResearchOrchestrator {
  private config: Config;
  private observer: ResearchObserver | undefined;

  constructor(private options: QuickResearchOrchestratorOptions) {
    this.config = options.config || getConfig(options.ctx.cwd);

    // Resolve observer: if options were provided instead of an instance, create the instance.
    // Either way, wrap it so a throwing observer callback can never fail the run.
    if (options.observer && typeof (options.observer as any).onProgress === 'function' && !(options.observer instanceof HeadlessObserver)) {
       this.observer = makeSafeObserver(new HeadlessObserver(options.observer as HeadlessObserverOptions));
    } else {
       this.observer = options.observer ? makeSafeObserver(options.observer as ResearchObserver) : undefined;
    }
  }

  async run(signal?: AbortSignal): Promise<string> {
    const { query, model, ctx, researchId } = this.options;
    const observer = this.observer;
    const container = tryGetServiceContainerFromCtx(ctx);
    const sessionStart = Date.now();
    logger.log(`[QuickOrchestrator] Starting research: "${query}"`);
    observer?.onStart?.(query, 0);

    let subscription: (() => void) | undefined;
    // Tracks whether a terminal callback (onComplete/onError) has fired, so the outer
    // catch below can fire onError for an EARLY throw (healthcheck/session-setup, before
    // the inner research try) without double-firing when the inner catch already handled it.
    let terminalCallbackFired = false;

    try {
        // Pre-flight health check to ensure browser pool is operational.
        // Consumers running sustained batch load (where the probe both costs up to a
        // full queue-wait of latency AND competes for a pool slot with real work) can
        // opt out with PI_RESEARCH_SKIP_HEALTHCHECK=1/true and rely on the per-task
        // search/scrape timeouts as the safety net. Honoring this flag also keeps the
        // SDK consistent with callers that already set it expecting a skip.
        const skipHealthcheck = process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] === '1' ||
          process.env['PI_RESEARCH_SKIP_HEALTHCHECK'] === 'true';
        const health = skipHealthcheck
          ? { success: true as boolean, error: undefined as string | undefined, components: [] as Array<{ component?: string; healthy?: boolean; error?: string }> }
          : await runHealthCheck({ ctx });
        if (skipHealthcheck) {
          logger.debug('[QuickOrchestrator] Pre-flight healthcheck skipped (PI_RESEARCH_SKIP_HEALTHCHECK); relying on per-task timeouts.');
        }
        if (!health.success) {
          // Distinguish a DEAD/uninitialized pool (must abort) from one that is merely BUSY —
          // under sustained concurrent load the BrowserRuntime probe queues behind in-flight
          // scrapes and times out even though the pool is operational. This discrimination
          // (the dominant 0-result cause under load) is a pure function so it is unit-tested.
          if (isBusyPoolHealthFailure(health)) {
            logger.warn(`[QuickOrchestrator] Browser pool busy — healthcheck probe queued out under load, but the pool is operational. Proceeding; per-task timeouts bound the work.`);
            metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'health_check_busy_proceed' });
          } else {
            const error = health.error || 'Unknown health check failure';
            logger.error(`[QuickOrchestrator] Health check failed: ${error}`);
            metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'health_check_failed' });
            throw new Error(`Research cannot start: ${error}`);
          }
        }

        // Knowledge Store Context Injection — skipped entirely when the store is
        // disabled (KNOWLEDGE_STORE_MODE='none'), so we never touch LanceDB. Without
        // this gate, concurrent quick runs sharing one DB corrupt it ("Bad file
        // descriptor"). Matches the gates in scrape.ts and the deep orchestrator.
        let storeSection = '';
        if (this.config.KNOWLEDGE_STORE_MODE !== 'none') {
        try {
          const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
          if (ksService.isReady()) {
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

        const researcherPromptTemplate = loadPrompt('researcher');
        const maxScrapeBatches = getMaxScrapeBatches(this.config);
        const maxScrapeBatchesDisplay = maxScrapeBatches > 99 ? 'unlimited' : maxScrapeBatches.toString();

        const quickEvidenceSection =
            '## Search\n' +
            'You have access to the `search` tool. You get EXACTLY ONE search call — make it count.\n' +
            'Submit **5–10 diverse, specific, and non-overlapping queries** covering the most important angles of the topic.\n' +
            'Each query must target a distinct piece of information. Avoid generic queries.\n' +
            `For roughly one in ${this.config.YOUTUBE_QUERY_EVERY_N} of your queries, append the word 'youtube' (e.g. "<topic> explained youtube") — DuckDuckGo rarely surfaces YouTube otherwise, and YouTube links let you read video transcripts.\n` +
            'Your goal is to gather a focused, high-quality pool of initial links.\n\n' +
            '## Scrape\n' +
            `After searching, scrape the best sources using the \`scrape\` tool (up to ${maxScrapeBatchesDisplay} batches, up to 4 URLs each).\n` +
            'Prioritize primary sources and authoritative data.';
        
        // Consume queued steering messages before starting
        consumeQueuedMessages(this.options.sessionId);
        const steeringMessages = getSteeringMessages(this.options.sessionId);
        let steeringSection = '';
        if (steeringMessages.length > 0) {
            steeringSection = '\n\n### ADDITIONAL CONSIDERATIONS\n' +
                steeringMessages.map(m => `- ${m.text}`).join('\n');
        }

        const evidenceLines: string[] = [];
        if (this.options.initialLinks && this.options.initialLinks.length > 0) {
          evidenceLines.push('## Initial Links\nInvestigate these provided URLs first:\n' + this.options.initialLinks.map(l => `- ${l}`).join('\n'));
        }
        evidenceLines.push(quickEvidenceSection);

        const prompt = injectCurrentDate(researcherPromptTemplate, 'researcher')
            // Function replacers: insert `$`-bearing dynamic content (scraped evidence,
            // store descriptions, the user query) literally, not as a substitution pattern.
            .replace('{{goal}}', () => query + steeringSection)
            .replace('{{store_section}}', () => storeSection)
            .replace('{{evidence_section}}', () => evidenceLines.join('\n\n'))
            .replace('{{coordination_section}}', '')
            .replace('{{extra_tool_guidelines}}', '- `search`: Perform broad web searches (Round 1 only).');

        logger.debug(`[QuickOrchestrator] System Prompt:\n${prompt}`);

        let lastSeenSearchCount = 0;
        const { session, resolvedModel } = await createResearcherSession({
          cwd: ctx.cwd,
          ctxModel: model,
          modelRegistry: ctx.modelRegistry,
          systemPrompt: prompt,
          extensionCtx: ctx,
          excludeTools: this.options.excludeTools || ['grep'],
          config: this.config,
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
          onUrlScrapeResult: (_url, success) => {
            observer?.onToolResult?.('quick', success);
          },
        });

        // Hand the freshly-created AgentSession to the cleanup machinery before
        // any other work. If resolving/registering the session service throws
        // (container disposed mid-run, race), the session is created but not yet
        // owned by cleanupResearchServices and would leak unaborted. Abort it
        // directly on any failure in this window, then rethrow. (Same
        // acquire-before-teardown-wired class as the ghost-panel fix.)
        let sessionService: ResearchSessionService;
        try {
          sessionService = await getService<ResearchSessionService>(ServiceNames.RESEARCH_SESSION_SERVICE, ctx, container);
          sessionService.registerSession(this.options.researchId, 'quick', session, () => session.abort().catch((err) => logger.warn('[QuickOrchestrator] Session abort failed:', err)));
        } catch (registrationError) {
          await session.abort().catch(() => { /* best-effort: session is being discarded */ });
          throw registrationError;
        }

        let lastSteeringCheck = Date.now();
        subscription = session.subscribe((event: AgentSessionEvent) => {
            // Check for new steering messages periodically (at most every 500ms to avoid spam)
            const now = Date.now();
            if (now - lastSteeringCheck > 500) {
                lastSteeringCheck = now;
                const newSteering = consumeQueuedMessages(this.options.sessionId);
                for (const msg of newSteering) {
                    session.steer(msg.text).catch(e => logger.warn('[QuickOrchestrator] Failed to deliver steering:', e));
                    logger.debug(`[QuickOrchestrator] Delivered mid-flight steering message: ${msg.text}`);
                }
            }

            if (event.type === 'message_end') {
                const msg = event.message as unknown as ResearchMessage;
                if (msg?.['role'] !== 'assistant') return;

                const rawUsage = msg['usage'] as any;
                if (rawUsage) {
                    const { tokens, cost } = extractUsage(resolvedModel, rawUsage);

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
                // Per-tool flash for non-scrape tools (scrape uses per-URL callback)
                if (event.toolName !== 'scrape') {
                    observer?.onToolResult?.('quick', !event.isError);
                }
                if (event.toolName === 'search') {
                    observer?.onSearchComplete?.(lastSeenSearchCount);
                }
            }
        });

        try {
          let timeoutId: NodeJS.Timeout | undefined;
          const timeoutPromise = new Promise<void>((_, reject) => {
              timeoutId = setTimeout(() => {
                  const msg = `Quick research timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`;
                  // Reject FIRST, abort as fire-and-forget cleanup — see researcher-executor:
                  // abort() awaits the stuck in-flight request, so gating the rejection on it
                  // settling disables the timeout exactly when it is needed.
                  session.abort().catch((err) => {
                      logger.warn('[QuickOrchestrator] Failed to abort timed-out session:', err);
                  });
                  reject(new Error(msg));
              }, this.config.RESEARCHER_TIMEOUT_MS);
          });

          // Keep onAbort in outer scope so the listener can be removed in finally
          // whether the race resolves via session.prompt, timeout, or abort.
          let abortCleanup: (() => void) | undefined;
          try {
            const promptPromise = session.prompt(query);
            promptPromise.catch((err: Error) => logger.debug(`[QuickOrchestrator] Background session prompt rejection: ${err.message}`));
            await Promise.race([
              promptPromise,
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
                    abortCleanup = () => signal.removeEventListener('abort', onAbort);
                  }
                })
              ] : []),
            ]);
          } finally {
            clearTimeout(timeoutId);
            if (abortCleanup) abortCleanup();
          }

          // The session has settled — the subscribe() poller above stops consuming
          // steering from here on. Flip steering OFF first (synchronously, before the
          // final consume, so there is no window where a new message can be queued
          // with the affirmative "will steer the next research round" toast and then
          // stranded): a steer typed from now on takes the input handler's
          // fall-through path to pi instead. Then consume anything queued in the last
          // poller window (≤500ms) so it is marked active and surfaced via
          // appendSteeringGuidance below rather than silently destroyed at teardown.
          observer?.onSynthesisStart?.();
          consumeQueuedMessages(this.options.sessionId);

          let result = ensureAssistantResponse(session, 'Quick');
          
          // Store report in synthesis service so citations can be verified/processed
          const synthesisService = await getService<IResearchSynthesisService>(ServiceNames.RESEARCH_SYNTHESIS_SERVICE, ctx, container);
          synthesisService.storeReport(this.options.researchId, 'quick', result);
          
          // Ensure CITED LINKS section is accurate and consistent
          result = synthesisService.ensureCitedLinks(this.options.researchId, result);

          // Append steering guidance — only active (consumed by orchestrator) messages
          const finalSteeringMessages = getActiveSteeringMessages(this.options.sessionId);
          result = synthesisService.appendSteeringGuidance(result, finalSteeringMessages);

          // NOTE: Model metadata (appendMetadata) is now applied at the very end
          // of the result chain in research-tool-definition.ts (or sdk.ts for SDK
          // users) so it always appears after metrics/summaries.

          const sessionDuration = Date.now() - sessionStart;
          metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'quick', complexity: '0', status: 'success' });
          logger.debug(`[QuickOrchestrator] Researcher Final Response:\n${result}`);
          
          // Extract citations and store agent-synthesized descriptions for vector/semantic search
          // Quick research is single-pass, so this is the final synthesis point
          try {
            if (this.config.KNOWLEDGE_STORE_MODE !== 'none') {
            const ksService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
            if (ksService.isReady()) {
              const writer = await getService<IWriterQueue>(ServiceNames.WRITER_QUEUE, ctx, container);
              const citations = parseCitations(result);
              if (citations.length === 0) {
                logger.warn('[QuickOrchestrator] Researcher produced no parseable CITED LINKS — no descriptions stored for this session');
              }
              let enqueued = 0;
              for (const cit of citations) {
                if (cit.url) {
                  const fullContent = getCachedScrapedContent(this.options.researchId, cit.url);
                  const markdown = cit.description || `(source: ${cit.url})`;
                  writer.enqueue({
                    url: normalizeUrl(cit.url),
                    markdown: markdown,
                    content: fullContent,
                    metadata: {
                      ingestionType: 'synthesis-description',
                      source: 'researcher',
                      synthesizedAt: new Date().toISOString(),
                      description: cit.description || '',
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
            }
          } catch (err) {
            logger.warn('[QuickOrchestrator] Failed to store link descriptions (non-fatal):', err);
          }

          metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: 'success' });
          // Complete the researcher slice before the run-level onComplete. Quick mode
          // never emitted this, so its single box was only ever completed as a side
          // effect of onSearchComplete — leaving it stuck when the researcher answered
          // without searching. Now the lifecycle mirrors deep mode.
          observer?.onResearcherComplete?.('quick', result);
          terminalCallbackFired = true;
          // A throwing user observer must not divert into the inner catch (which
          // would fire onError too — a double terminal callback — and discard the
          // result). Isolate it, mirroring the deep orchestrator + researcher-executor.
          try {
            observer?.onComplete?.(result);
          } catch (obsErr) {
            logger.debug('[QuickOrchestrator] onComplete observer threw:', obsErr);
          }
          return result;
        } catch (error) {
          // Terminal-callback contract (shared with DeepResearchOrchestrator):
          // fire EXACTLY ONE of onComplete / onError. Quick mode produces its
          // result atomically at the end and keeps no per-round reports, so a
          // mid-run failure or cancel has nothing partial to return — it is an
          // onError + throw, mirroring Deep's "no collected reports" branch.
          const sessionDuration = Date.now() - sessionStart;
          const aborted = signal?.aborted === true;
          metrics.observe('research_session_duration_ms', sessionDuration, { mode: 'quick', complexity: '0', status: aborted ? 'cancelled' : 'error' });
          metrics.increment('research_sessions_total', 1, { mode: 'quick', complexity: '0', status: aborted ? 'cancelled' : 'error' });
          // Mark the researcher slice failed for a genuine fault (not a user cancel, which
          // is not a failure). Deep mode fails its slices via onResearcherFailure too.
          if (!aborted) {
            observer?.onResearcherFailure?.('quick', error instanceof Error ? error.message : String(error));
          }
          terminalCallbackFired = true;
          try {
            observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
          } catch (obsErr) {
            logger.debug('[QuickOrchestrator] onError observer threw:', obsErr);
          }
          throw error;
        }
    } catch (error) {
        // Any throw BEFORE the inner research try (healthcheck failure at :99, session
        // registration at :212, container disposed mid-setup) skips the inner catch, so
        // without this run() would reject with onStart fired but no terminal callback —
        // leaving the TUI/headless quick slice stuck "in progress" forever. Fire onError
        // exactly once (the inner catch sets the flag for its own scope).
        if (!terminalCallbackFired) {
          const aborted = signal?.aborted === true;
          if (!aborted) {
            observer?.onResearcherFailure?.('quick', error instanceof Error ? error.message : String(error));
          }
          try {
            observer?.onError?.(error instanceof Error ? error : new Error(String(error)));
          } catch (obsErr) {
            logger.debug('[QuickOrchestrator] onError observer threw (early-throw path):', obsErr);
          }
        }
        throw error;
    } finally {
        if (subscription) subscription();

        // Restore the default thinking label now that the researcher is done.
        // Otherwise "Researcher X" persists for all subsequent agent turns.
        // Symmetric with where the label is set (researcher.ts): a no-op in the
        // research TUI, where the label is never applied in the first place.
        if (ctx.mode !== 'tui' && ctx.hasUI && typeof ctx.ui.setHiddenThinkingLabel === 'function') {
          ctx.ui.setHiddenThinkingLabel();
        }

        try {
          const orch = await getService<IResearchOrchestration>(ServiceNames.RESEARCH_ORCHESTRATION, ctx, container);
          // Pass ctx so cleanup resolves the SAME container-scoped services (synthesis,
          // session) the run used — without it the container-local instances never get
          // cleared and reports accumulate toward MAX_SESSIONS eviction (matches the
          // DeepResearchOrchestrator cleanup call).
          // On user abort, skip the FTS rebuild + optimize (non-signal-aware
          // optimization passes) so Esc returns promptly — mirrors deep mode; the
          // next run's cleanup performs the same rebuild.
          await orch.cleanupResearchServices(undefined, researchId, ctx, this.config,
            { skipStoreMaintenance: signal?.aborted === true });
        } catch (err) {
          logger.warn('[QuickOrchestrator] Failed to cleanup research services:', err);
        }
    }
  }
}
