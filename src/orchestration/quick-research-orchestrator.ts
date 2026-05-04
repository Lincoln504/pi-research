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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectCurrentDate } from '../utils/inject-date.ts';
import { calculateTotalTokens, parseTokenUsage } from '../types/llm.ts';
import { logger } from '../logger.ts';
import { getConfig, type Config } from '../config.ts';
import { createResearcherSession } from './researcher.ts';
import { ensureAssistantResponse } from '../utils/text-utils.ts';
import { getMaxScrapeBatches } from '../constants.ts';
import type { ResearchObserver } from './research-observer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    const researcherPromptTemplate = readFileSync(join(__dirname, '..', 'prompts', 'researcher.md'), 'utf-8');
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
        .replace('{{evidence_section}}', quickEvidenceSection)
        .replace('{{coordination_section}}', '')
        .replace('{{extra_tool_guidelines}}', '- `search`: Perform broad web searches (Round 1 only).');

    const extendedCtx = ctx as any;
    const session = await createResearcherSession({
      cwd: ctx.cwd,
      ctxModel: model,
      modelRegistry: ctx.modelRegistry,
      settingsManager: extendedCtx.settingsManager,
      systemPrompt: prompt,
      extensionCtx: ctx,
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
                observer?.onSearchStart?.([]);
            }
        } else if (event.type === 'tool_execution_end') {
            observer?.onResearcherProgress?.('quick', '');
            if (event.toolName === 'search') {
                observer?.onSearchComplete?.(0); // Count not easily available here
            }
        }
    });

    try {
      const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => {
              const msg = `Quick research timed out after ${this.config.RESEARCHER_TIMEOUT_MS}ms`;
              session.abort().catch(() => {}).finally(() => reject(new Error(msg)));
          }, this.config.RESEARCHER_TIMEOUT_MS);
      });

      await Promise.race([
        session.prompt(query),
        timeoutPromise,
        new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error('Aborted'));
          signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        }),
      ]);
      
      const result = ensureAssistantResponse(session, 'Quick');
      observer?.onComplete?.(result);
      return result;
    } finally {
      subscription();
    }
  }
}
