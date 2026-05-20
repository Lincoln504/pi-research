/**
 * Quick Research Orchestrator
 *
 * Implements the single-agent research loop.
 * Optimized for speed and efficiency for simple queries.
 */

import { 
    type ExtensionContext, 
    type AgentSessionEvent 
} from '@mariozechner/pi-coding-agent';
import { type Model } from '@mariozechner/pi-ai';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { createResearcherSession } from './researcher.ts';
import { ensureAssistantResponse, parseCitations } from '../utils/text-utils.ts';
import { getMaxScrapeBatches } from '../constants.ts';
import type { ResearchObserver } from './research-observer.ts';
import { isKnowledgeStoreReady, getStore, getWriterQueue } from '../knowledge/index.ts';
import { normalizeUrl } from '../utils/shared-links.ts';

export interface QuickResearchOrchestratorOptions {
  ctx: ExtensionContext;
  model: Model<any>;
  query: string;
  sessionId: string;
  researchId: string;
  observer?: ResearchObserver;
  config?: Config;
}

export class QuickResearchOrchestrator {
  private config: Config;

  constructor(private options: QuickResearchOrchestratorOptions) {
    this.config = options.config || getConfig();
  }

  async run(signal?: AbortSignal): Promise<string> {
    const { query, model, ctx, observer } = this.options;
    logger.log(`[QuickOrchestrator] Starting research: "${query}"`);
    observer?.onStart?.(query, 0);

    // Knowledge Store Context Injection
    let storeSection = '';
    if (isKnowledgeStoreReady()) {
      try {
        const store = getStore();
        const historicalUrls = await store.findRelevantUrls(query, { limit: 5 });
        if (historicalUrls.length > 0) {
          storeSection = '\n## Historical Knowledge Store (Discovery)\n' +
            'The following URLs were found in your local knowledge store. They contain summaries of findings from previous research sessions:\n' +
            historicalUrls.map(u => `- ${u}`).join('\n') +
            '\n\nScrape these URLs to retrieve a historical summary hint and the fresh full content.';
        }
      } catch (err) {
        logger.warn('[QuickOrchestrator] Failed to fetch historical URLs:', err);
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
        .replace('{{extra_tool_guidelines}}', '- `search`: Perform broad web searches (Round 1 only).');

    logger.debug(`[QuickOrchestrator] System Prompt:\n${prompt}`);

    const extendedCtx = ctx as any;
    const session = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      settingsManager: extendedCtx.settingsManager,
      systemPrompt: prompt,
      extensionCtx: ctx,
      getGlobalState: () => ({ researchId: this.options.researchId } as any),
      onSearchProgress: (links) => {
        observer?.onSearchProgress?.(links);
      },
    });

    const subscription = session.subscribe((event: AgentSessionEvent) => {
        if (event.type === 'message_end') {
            const msg = event.message as any;
            if (msg?.role !== 'assistant') return;
            const rawUsage = msg.usage;
            if (rawUsage) {
                const parsed = parseTokenUsage(rawUsage);
                const tokens = calculateTotalTokens(parsed);
                const cost: number = (rawUsage as any).cost?.total ?? 0;
                if (tokens > 0 || cost > 0) {
                    observer?.onResearcherProgress?.('quick', undefined, tokens, cost);
                    observer?.onTokensConsumed?.(tokens, cost);
                }
            }
        } else if (event.type === 'tool_execution_start') {
            observer?.onResearcherProgress?.('quick', event.toolName);
            if (event.toolName === 'search') {
                observer?.onSearchStart?.(event.args.queries || []);
            }
        } else if (event.type === 'tool_execution_end') {
            observer?.onResearcherProgress?.('quick', `done:${event.toolName}`);
            if (event.toolName === 'search') {
                observer?.onSearchComplete?.(0); // Count not easily available here
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
              }
            })
          ] : []),
        ]);
      } finally {
        clearTimeout(timeoutId!);
      }
      
      const result = ensureAssistantResponse(session, 'Quick');
      logger.debug(`[QuickOrchestrator] Researcher Final Response:\n${result}`);
      
      // Extract citations and store agent-synthesized descriptions for vector/semantic search
      // Quick research is single-pass, so this is the final synthesis point
      if (isKnowledgeStoreReady()) {
        const writer = getWriterQueue();
        const citations = parseCitations(result);
        for (const cit of citations) {
          if (cit.url && cit.description) {
            // Store the agent-synthesized description as the searchable text field
            // This description is used for vector/semantic search
            writer.enqueue({ 
              url: normalizeUrl(cit.url), 
              markdown: cit.description,
              metadata: { 
                ingestionType: 'synthesis-description',
                source: 'quick-synthesis-evaluator',
                synthesizedAt: new Date().toISOString()
              }
            });
          }
        }
      }

      observer?.onComplete?.(result);
      return result;
    } finally {
      subscription();
    }
  }
}
