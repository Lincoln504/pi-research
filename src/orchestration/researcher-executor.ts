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
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { calculateCost } from '@earendil-works/pi-ai';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { getResearchSessionService, getResearchSynthesisService } from './research-session-manager.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { injectCurrentDate } from '../utils/inject-date.ts';
import type { RunResearcherOptions } from './orchestration-types.ts';
import type { ResearchObserver } from './research-observer.ts';

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
  } = options;
  
  // Explicitly type the observer to satisfy TypeScript
  const typedObserver: ResearchObserver | undefined = observer as ResearchObserver | undefined;

  const id = String(researcherConfig.id);
  typedObserver?.onResearcherStart?.(id, researcherConfig.name, researcherConfig.goal, round);
  metrics.increment('researchers_launched_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });

  const currentPlan = planningService.getCurrentPlan();
  const previousQueriesSection = currentPlan?.allQueries && currentPlan.allQueries.length > 0
    ? `\n### Previous Queries (Sibling Researchers)\n${currentPlan.allQueries.map((q: string) => `- ${q}`).join('\n')}\n`
    : '';

  let storeSection = '';
  if (historicalUrls.length > 0) {
    storeSection = '\n## Historical Knowledge Store\n' +
      'The following URLs were found in your local knowledge store. Scrape them to retrieve a historical summary and the full content.\n' +
      historicalUrls.map(u => `- ${u}`).join('\n');
  }

  const researcherPromptTemplate = loadPrompt('researcher', '..');
  if (initialLinks.length === 0 && historicalUrls.length === 0) {
    logger.warn(`[ResearcherExecutor] Researcher ${id} has no initial search results or historical links; skipping.`);
    typedObserver?.onResearcherComplete?.(id, '');
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
      typedObserver?.onResearcherProgress?.(id, `Retry ${attempt - 1}...`);
      await new Promise(r => setTimeout(r, delay));
    }

    const session = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      settingsManager: extendedCtx['settingsManager'],
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
        typedObserver?.onResearcherProgress?.(id, `${links} Results`);
      },
    });

    const sessionService = await getResearchSessionService();
    sessionService.registerSession(id, session, () => session.abort().catch(() => {}));

    const subscription = session.subscribe((event: any) => {
      if (event.type === 'message_end') {
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
          const parsed = parseTokenUsage(rawUsage);
          const tokens = calculateTotalTokens(parsed);
          
          // Ultra-accurate cost calculation
          let cost = parsed.cost?.total ?? rawUsage.cost?.total ?? 0;
          if (cost === 0 && tokens > 0) {
              const calculatedCost = calculateCost(model, rawUsage);
              cost = calculatedCost.total;
          }

          if (tokens > 0 || cost > 0) {
            metrics.increment('llm_tokens_total', tokens, { component: 'researcher', complexity: String(complexity) });
            metrics.increment('llm_cost_total', cost, { component: 'researcher', complexity: String(complexity) });
            typedObserver?.onResearcherProgress?.(id, undefined, tokens, cost);
            typedObserver?.onTokensConsumed?.(tokens, cost);
          }
        }
      } else if (event.type === 'tool_execution_start') {
        typedObserver?.onResearcherProgress?.(id, `${event.toolName}`);
      } else if (event.type === 'tool_execution_end') {
        typedObserver?.onResearcherProgress?.(id, `done:${event.toolName}`);
      }
    });

    try {
      let timeoutId: NodeJS.Timeout;
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
        await Promise.race([
          session.prompt(`Topic: ${researcherConfig.name}\nGoal: ${researcherConfig.goal}\n\nPerform your research and submit your full report now.`),
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
                (abortCleanup as any) = () => signal.removeEventListener('abort', onAbort);
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
      logger.debug(`[ResearcherExecutor] Researcher ${id} Final Response:\n${responseText}`);

      const synthesisService = await getResearchSynthesisService();
      synthesisService.storeReport(`${round}.${id}`, responseText);

      typedObserver?.onResearcherComplete?.(id, responseText);
      return;
    } catch (err) {
      const researcherDuration = Date.now() - researcherExecutionStartMs;
      metrics.observe('researcher_execution_latency_ms', researcherDuration, { mode: 'deep', complexity: String(complexity), round: String(round), status: 'error' });
      metrics.increment('researcher_errors_total', 1, { mode: 'deep', complexity: String(complexity), round: String(round) });
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
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
      sessionService.unregisterSession(id);
    }
  }

  throw lastError;
}