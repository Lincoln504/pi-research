/**
 * Research Knowledge Search Tool
 *
 * A satellite tool for the main pi agent that searches the local vector
 * database for previously researched information. This is NOT a researcher
 * sub-agent tool — the research orchestration already injects historical
 * URLs into researcher prompts via the store_section mechanism.
 *
 * Architecture (5 phases):
 *
 *   Phase 1: Strict Contracts — rigid JSON schema for background LLM output
 *   Phase 2: Safe Data Rehydration — vector search → URL dedup → rebuildDocument
 *   Phase 3: Conversational Continuity — pi SDK's buildSessionContext pipeline
 *   Phase 4: Stateless Background Execution — completeSimple + agentic repair
 *   Phase 5: Orchestration Steering — pivot string on miss, clean report on hit
 *
 * Registration: pi.registerTool() in src/index.ts (alongside research & health).
 * NOT in createResearchTools() — sub-researchers already get knowledge store
 * data injected via store_section in their prompts.
 */

import type {
  ToolDefinition,
  AgentToolResult,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { ModelWithId } from '../types/extension-context.ts';
import type { Config } from '../config.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { completeSimple, type TextContent } from '@earendil-works/pi-ai';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import type { ResearchKnowledgeSynthesisResponse } from './research-knowledge-types.ts';
import {
  ResearchKnowledgeSynthesisResponseSchema,
  ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
} from './research-knowledge-types.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { extractJson } from '../utils/json-utils.ts';
import { repairJsonWithLlm } from '../utils/agentic-repair.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { formatParentContext } from '../orchestration/session-context.ts';
import { getConfig } from '../config.ts';

// ---------------------------------------------------------------------------
// Phase 1: Tool Parameters
// ---------------------------------------------------------------------------

const ResearchKnowledgeSearchParams = Type.Object({
  queries: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 5,
    description:
      'Search queries to look up in the research knowledge database (1-5 queries). ' +
      'Use multiple queries to cover different aspects of the topic.',
  }),
});

type ResearchKnowledgeSearchParams = Static<typeof ResearchKnowledgeSearchParams>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard limit on total reference text size (chars) to prevent token overflow */
const MAX_REFERENCE_CHARS = 120_000;

/** Maximum number of unique URLs to rebuild documents for */
const MAX_DOCUMENTS = 10;

/**
 * System string returned when the answer is NOT found in the research
 * knowledge database. The exact phrasing is critical — the main pi agent
 * reads this as a signal to pivot to live web research.
 */
const RESEARCH_KNOWLEDGE_MISS_STRING =
  'No relevant data found in research knowledge store. You are now authorized to proceed with live web research and scraping tools.';

// ---------------------------------------------------------------------------
// Phase 2: Safe Data Rehydration
// ---------------------------------------------------------------------------

/**
 * Deduplicate URLs from multiple vector search results and rebuild pristine
 * documents. Uses the store's native rebuildDocument() method which queries
 * for synthesis-description metadata blocks — guaranteeing unfragmented
 * original markdown, not stitched-together vector chunks.
 *
 * The deduplication logic uses a Map to track first-appearance order, so
 * the earliest (most relevant) query result for each URL is retained.
 */
async function assembleReferenceDocuments(
  queries: string[],
  store: import('../core/interfaces/knowledge-interfaces.ts').IKnowledgeStore,
): Promise<{ text: string; urls: string[] }> {
  const allUrls = new Map<string, number>();

  for (const query of queries) {
    try {
      const results = await store.findRelevantUrls(query, { limit: 20 });
      for (const entry of results) {
        if (!allUrls.has(entry.url)) {
          allUrls.set(entry.url, allUrls.size);
        }
      }
    } catch (err) {
      logger.debug(`[research-knowledge-search] Vector search failed for query "${query}": ${err}`);
    }
  }

  if (allUrls.size === 0) {
    return { text: '', urls: [] };
  }

  // Sort by first-appearance order (lower = more relevant)
  const sortedUrls = [...allUrls.keys()]
    .sort((a, b) => (allUrls.get(a) ?? Infinity) - (allUrls.get(b) ?? Infinity))
    .slice(0, MAX_DOCUMENTS);

  const documentParts: string[] = [];
  let totalChars = 0;

  for (const url of sortedUrls) {
    try {
      const rebuilt = await store.rebuildDocument(url);
      if (!rebuilt) {
        logger.debug(`[research-knowledge-search] Could not rebuild document for ${url}`);
        continue;
      }

      const header = `\n---\n### Source: ${url}\n`;
      const docText = rebuilt.text || '';
      const entry = header + docText;

      // Token budget enforcement: if this document would exceed the limit,
      // truncate it and stop adding any further (lower-ranked) documents.
      if (totalChars + entry.length > MAX_REFERENCE_CHARS) {
        const remaining = MAX_REFERENCE_CHARS - totalChars - header.length;
        if (remaining > 500) {
          documentParts.push(header + docText.slice(0, remaining) + '\n[TRUNCATED]');
          totalChars = MAX_REFERENCE_CHARS;
        }
        break;
      }

      documentParts.push(entry);
      totalChars += entry.length;
    } catch (err) {
      logger.debug(`[research-knowledge-search] Failed to rebuild ${url}: ${err}`);
    }
  }

  return { text: documentParts.join('\n'), urls: sortedUrls };
}

// ---------------------------------------------------------------------------
// Phase 3: Conversational Continuity
// ---------------------------------------------------------------------------

/**
 * Serialize the current conversation branch using pi SDK's native pipeline:
 *   getBranch() → buildSessionContext → convertToLlm → serializeConversation
 *
 * This strips system metadata, compaction entries, and tool-result noise,
 * producing a dense conversational transcript the background LLM can use
 * to understand the user's overarching intent.
 */
async function serializeConversationHistory(ctx: ExtensionContext): Promise<string> {
  try {
    return await formatParentContext(ctx);
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to serialize conversation history: ${err}`);
    return '(Conversation context unavailable)';
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Stateless Background Execution + Agentic Repair
// ---------------------------------------------------------------------------

/**
 * Resolve the model to use for the background synthesis LLM.
 *
 * Priority:
 *   1. KNOWLEDGE_SYNTHESIS_MODEL — dedicated lightweight synthesis model
 *   2. RESEARCH_MODEL — the shared research coordination model
 *   3. ctx.model — the main agent's current model
 */
function resolveSynthesisModel(ctx: ExtensionContext): { model: ModelWithId; error?: string } {
  const config: Config = getConfig();
  const modelRegistry = ctx.modelRegistry;
  const ctxModel = ctx.model as ModelWithId | undefined;

  if (config.KNOWLEDGE_SYNTHESIS_MODEL) {
    const target = config.KNOWLEDGE_SYNTHESIS_MODEL;
    const found = modelRegistry.getAll().find(
      (m: any) => `${m.provider}/${m.id}` === target || m.id === target,
    );
    if (found) {
      return { model: found as unknown as ModelWithId };
    }
    logger.warn(`[research-knowledge-search] KNOWLEDGE_SYNTHESIS_MODEL '${target}' not found`);
  }

  if (config.RESEARCH_MODEL) {
    const target = config.RESEARCH_MODEL;
    const found = modelRegistry.getAll().find(
      (m: any) => `${m.provider}/${m.id}` === target || m.id === target,
    );
    if (found) {
      return { model: found as unknown as ModelWithId };
    }
    logger.warn(`[research-knowledge-search] RESEARCH_MODEL '${target}' not found`);
  }

  if (ctxModel) {
    return { model: ctxModel };
  }

  return { model: undefined as any, error: 'No model available for knowledge synthesis' };
}

/**
 * Invoke the background LLM via completeSimple — a purely stateless call
 * with no agent session, no side effects, and no UI updates.
 *
 * The response undergoes a two-phase validation:
 *   1. Direct JSON extraction with full TypeBox schema validation
 *   2. Agentic repair fallback (re-prompts LLM with schema enforcement)
 *
 * If both phases fail, returns a safe default (answer_found: false).
 */
async function runBackgroundExtraction(
  model: ModelWithId,
  auth: { apiKey: string; headers?: Record<string, string> },
  conversationHistory: string,
  referenceDocuments: string,
  signal?: AbortSignal,
): Promise<ResearchKnowledgeSynthesisResponse> {
  const promptTemplate = loadPrompt('research-knowledge-search-extractor', '..');
  if (!promptTemplate) {
    throw new Error('research-knowledge-search prompt template not found');
  }

  const systemPrompt = promptTemplate
    .replace('{{conversation_history}}', conversationHistory)
    .replace('{{reference_documents}}', referenceDocuments);

  const userMessage =
    'Analyze the reference documents above and extract the answer using the required JSON format.';

  // Phase 4a: Stateless LLM call — no AgentSession, no side-effects
  const response = await completeSimple(model as any, {
    systemPrompt,
    messages: [
      { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
    ],
  }, { apiKey: auth.apiKey, headers: auth.headers, signal });

  // Extract text using the typed find pattern (matches planning-service.ts)
  const textContent = response.content?.find((c): c is TextContent => c.type === 'text');
  const responseText = textContent?.text;

  if (!responseText) {
    throw new Error('Background LLM returned no text content');
  }

  // Phase 4b: Direct JSON extraction + TypeBox validation
  // (matches the pattern in planning-utils.ts parseJsonPlan)
  const extracted = extractJson<ResearchKnowledgeSynthesisResponse>(responseText, 'object');
  if (extracted.success && extracted.value) {
    try {
      const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, extracted.value);
      if (Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)) {
        return coerced as ResearchKnowledgeSynthesisResponse;
      }
      const errors = [...Value.Errors(ResearchKnowledgeSynthesisResponseSchema, coerced)];
      const errorDetail = errors.map((e: any) => `${e.path}: ${e.message}`).join(', ');
      logger.debug(`[research-knowledge-search] Schema validation failed: ${errorDetail}`);
    } catch (validationErr) {
      logger.debug(`[research-knowledge-search] TypeBox validation error: ${validationErr}`);
    }
  }

  // Phase 4c: Agentic Repair — re-prompt the LLM with the schema embedded
  // so it knows the exact required shape. repairJsonWithLlm internally runs
  // Value.Convert + Value.Check on each retry (up to 2 attempts).
  logger.warn('[research-knowledge-search] Background LLM response malformed, attempting agentic repair');

  const repaired = await repairJsonWithLlm<ResearchKnowledgeSynthesisResponse>(
    responseText,
    completeSimple,
    auth,
    {
      model: model as any,
      schema: ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
      context: 'Knowledge search extraction — synthesizing answer from reference documents',
      serviceName: 'ResearchKnowledgeSearch',
      signal,
    },
  );

  if (repaired) {
    return repaired;
  }

  // Phase 4d: Safe fallback — treat as not found rather than crashing
  logger.error('[research-knowledge-search] Agentic repair failed, returning NOT_FOUND');
  return { answer_found: false, synthesis: '', citations: [] };
}

// ---------------------------------------------------------------------------
// Tool Factory
// ---------------------------------------------------------------------------

/**
 * Create the Research Knowledge Search tool definition.
 *
 * This tool is a top-level satellite of the main `research` tool, registered
 * via pi.registerTool() in src/index.ts — NOT in createResearchTools().
 */
export function createResearchKnowledgeSearchTool(): ToolDefinition {
  return {
    name: 'research_knowledge_search',
    label: 'Research Knowledge Search',
    description:
      'A satellite tool for the main pi agent and pi-research. Queries the research knowledge database ' +
      'for previously researched information. ALWAYS use this before performing live internet research ' +
      'or scraping, as previous research sessions may have already solved this.',
    promptSnippet: 'Search research knowledge database for previously researched information',
    promptGuidelines: [
      'Always try `research_knowledge_search` first for any research question — it is instant and free.',
      'If research_knowledge_search returns a miss, proceed with the `research` tool for live web investigation.',
      'Do NOT call both research_knowledge_search and research for the same question simultaneously.',
    ],
    parameters: ResearchKnowledgeSearchParams,
    executionMode: 'parallel',
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const startTime = Date.now();
      const p = params as ResearchKnowledgeSearchParams;

      try {
        // ----------------------------------------------------------
        // Service resolution via central registry (not direct instantiation)
        // ----------------------------------------------------------
        let storeService: IKnowledgeStoreService;
        try {
          storeService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
        } catch {
          metrics.increment('research_knowledge_search_total', 1, { status: 'store_unavailable' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: 'store_unavailable' },
          };
        }

        if (!storeService.isReady()) {
          metrics.increment('research_knowledge_search_total', 1, { status: 'store_not_ready' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: 'store_not_ready' },
          };
        }

        const store = await storeService.getStore();

        const count = await store.count();
        if (count === 0) {
          metrics.increment('research_knowledge_search_total', 1, { status: 'store_empty' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: 'store_empty' },
          };
        }

        // ----------------------------------------------------------
        // Phase 2: Vector search → URL dedup → rebuildDocument
        // ----------------------------------------------------------
        const { text: referenceText, urls } = await assembleReferenceDocuments(p.queries, store);

        if (!referenceText || referenceText.length === 0) {
          metrics.increment('research_knowledge_search_total', 1, { status: 'no_results' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: 'no_results' },
          };
        }

        // ----------------------------------------------------------
        // Phase 3: Conversational continuity via pi SDK pipeline
        // ----------------------------------------------------------
        const conversationHistory = await serializeConversationHistory(ctx);

        // ----------------------------------------------------------
        // Phase 4: Model routing → stateless LLM → agentic repair
        // ----------------------------------------------------------
        const { model, error: modelError } = resolveSynthesisModel(ctx);
        if (modelError || !model) {
          metrics.increment('research_knowledge_search_total', 1, { status: 'no_model' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: modelError || 'no_model' },
          };
        }

        const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model as any);
        if (!authResult.ok) {
          logger.warn(`[research-knowledge-search] Model auth failed: ${authResult.error}`);
          metrics.increment('research_knowledge_search_total', 1, { status: 'auth_failed' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false, reason: 'auth_failed' },
          };
        }

        const result = await runBackgroundExtraction(
          model,
          { apiKey: authResult.apiKey || '', headers: authResult.headers },
          conversationHistory,
          referenceText,
          signal,
        );

        const durationMs = Date.now() - startTime;
        metrics.observe('research_knowledge_search_duration_ms', durationMs);

        // ----------------------------------------------------------
        // Phase 5: Orchestration Steering
        // ----------------------------------------------------------
        if (!result.answer_found) {
          metrics.increment('research_knowledge_search_total', 1, { status: 'not_found' });
          return {
            content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
            details: { source: 'research_knowledge_search', found: false },
          };
        }

        // The Delivery: format the synthesized answer with bibliography
        metrics.increment('research_knowledge_search_total', 1, { status: 'found' });
        metrics.increment('research_knowledge_search_citations_total', result.citations.length);

        const synthesis = result.synthesis || '';
        let report = synthesis;

        if (result.citations.length > 0) {
          report += '\n\n### Sources\n';
          for (let i = 0; i < result.citations.length; i++) {
            report += `${i + 1}. ${result.citations[i]}\n`;
          }
          report += '\n---';
        }

        return {
          content: [{ type: 'text', text: report }],
          details: {
            source: 'research_knowledge_search',
            found: true,
            citations: result.citations,
            documentsSearched: urls.length,
          },
        };
      } catch (error) {
        const durationMs = Date.now() - startTime;
        metrics.observe('research_knowledge_search_duration_ms', durationMs, { status: 'error' });
        metrics.increment('research_knowledge_search_total', 1, { status: 'error' });

        logger.error('[research-knowledge-search] Tool execution failed:', error);

        return {
          content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
          details: { source: 'research_knowledge_search', found: false, error: String(error) },
        };
      }
    },
  };
}