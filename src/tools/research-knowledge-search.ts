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
import type { Config } from '../config.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { completeSimple, type TextContent, type Model } from '@earendil-works/pi-ai';
import { getService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import type { ResearchKnowledgeSynthesisResponse } from './research-knowledge-types.ts';
import {
  ResearchKnowledgeSynthesisResponseSchema,
  ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
  legacyBooleanToStatus,
} from './research-knowledge-types.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { extractJson } from '../utils/json-utils.ts';
import { repairJsonWithLlm } from '../utils/agentic-repair.ts';
import { loadPrompt } from '../utils/prompts.ts';
import { formatParentContext } from '../orchestration/session-context.ts';
import { getConfig } from '../config.ts';
import { createKnowledgeSearchPanel } from '../tui/knowledge-search-panel.ts';

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

/** Widget ID for the knowledge search TUI panel */
const KNOWLEDGE_WIDGET_ID = 'pi-research-knowledge-search';

/**
 * System string returned when the answer is NOT found in the research
 * knowledge database. The exact phrasing is critical — the main pi agent
 * reads this as a signal to pivot to live web research.
 */
const RESEARCH_KNOWLEDGE_MISS_STRING =
  'No relevant data found in research knowledge store. You are now authorized to proceed with live web research and scraping tools.';

/**
 * System string returned when the knowledge store returned partial results.
 * The host agent gets a synthesis of what was found but is also told to
 * continue with live research for a more complete answer.
 */
const RESEARCH_KNOWLEDGE_MAYBE_STRING =
  'Partial data found in research knowledge store. The synthesis above summarizes what is available. ' +
  'You should still proceed with live web research to fill gaps and get a more complete answer.';

// ---------------------------------------------------------------------------
// TUI Helpers
// ---------------------------------------------------------------------------

/**
 * Show the knowledge search TUI widget (bordered box with "searching knowledge store").
 * Only renders in TUI mode with UI available.
 */
function showKnowledgeSearchWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== 'tui' || !ctx.hasUI) return;
  try {
    const panelFactory = createKnowledgeSearchPanel();
    ctx.ui.setWidget(KNOWLEDGE_WIDGET_ID, panelFactory as any, { placement: 'aboveEditor' });
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to show TUI widget: ${err}`);
  }
}

/**
 * Remove the knowledge search TUI widget.
 */
function hideKnowledgeSearchWidget(ctx: ExtensionContext): void {
  if (ctx.mode !== 'tui' || !ctx.hasUI) return;
  try {
    ctx.ui.setWidget(KNOWLEDGE_WIDGET_ID, undefined as any, { placement: 'aboveEditor' });
  } catch (err) {
    logger.debug(`[research-knowledge-search] Failed to hide TUI widget: ${err}`);
  }
}

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
  const resultsMap = new Map<string, { url: string; description: string; provenance?: string }>();

  for (const query of queries) {
    try {
      const results = await store.findRelevantUrls(query, { limit: 20 });
      for (const entry of results) {
        if (!allUrls.has(entry.url)) {
          allUrls.set(entry.url, allUrls.size);
          resultsMap.set(entry.url, entry);
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

      // Find original entry for provenance
      const provenance = resultsMap.get(url)?.provenance || 'unknown';
      const header = `\n---\n### Source: ${url}\n#### Provenance: ${provenance}\n`;
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
 *   1. RESEARCH_MODEL — the shared research model override
 *   2. ctx.model — the main agent's current model
 */
function resolveSynthesisModel(ctx: ExtensionContext): { model?: Model<any>; error?: string } {
  const config: Config = getConfig();
  const modelRegistry = ctx.modelRegistry;
  const ctxModel = ctx.model as Model<any> | undefined;

  if (config.RESEARCH_MODEL) {
    const target = config.RESEARCH_MODEL;
    const found = modelRegistry.getAll().find(
      (m) => `${m.provider}/${m.id}` === target || m.id === target,
    );
    if (found) {
      return { model: found };
    }
    logger.warn(`[research-knowledge-search] RESEARCH_MODEL '${target}' not found`);
  }

  if (ctxModel) {
    return { model: ctxModel };
  }

  return { error: 'No model available for knowledge synthesis' };
}

/**
 * Coerce a raw LLM response into the tri-state schema.
 *
 * Handles both the new `answer_status` field and the legacy `answer_found`
 * boolean. If the LLM returns the old field, it's converted automatically.
 */
function coerceResponse(raw: unknown): ResearchKnowledgeSynthesisResponse | null {
  if (!raw || typeof raw !== 'object') return null;

  // Try legacy boolean conversion first
  const legacy = legacyBooleanToStatus(raw);
  if (legacy) {
    const obj = { ...(raw as Record<string, unknown>), ...legacy };
    delete (obj as Record<string, unknown>)['answer_found']; // remove old field
    try {
      const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, obj);
      if (Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)) {
        return coerced as ResearchKnowledgeSynthesisResponse;
      }
    } catch {
      // Fall through to normal path
    }
  }

  // Normal path: direct TypeBox coercion
  try {
    const coerced = Value.Convert(ResearchKnowledgeSynthesisResponseSchema, raw);
    if (Value.Check(ResearchKnowledgeSynthesisResponseSchema, coerced)) {
      return coerced as ResearchKnowledgeSynthesisResponse;
    }
  } catch {
    // Fall through
  }

  return null;
}

/**
 * Invoke the background LLM via completeSimple — a purely stateless call
 * with no agent session, no side effects, and no UI updates.
 *
 * The response undergoes a two-phase validation:
 *   1. Direct JSON extraction with full TypeBox schema validation
 *   2. Agentic repair fallback (re-prompts LLM with schema enforcement)
 *
 * If both phases fail, returns a safe default (answer_status: "no").
 */
async function runBackgroundExtraction(
  model: Model<any>,
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
  const response = await completeSimple(model, {
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

  // Phase 4b: Direct JSON extraction + TypeBox validation with legacy coercion
  const extracted = extractJson<ResearchKnowledgeSynthesisResponse>(responseText, 'object');
  if (extracted.success && extracted.value) {
    const coerced = coerceResponse(extracted.value);
    if (coerced) {
      return coerced;
    }
    // Log why validation failed
    try {
      const errors = [...Value.Errors(ResearchKnowledgeSynthesisResponseSchema, extracted.value)];
      const errorDetail = errors.map((e: any) => `${e.path}: ${e.message}`).join(', ');
      logger.debug(`[research-knowledge-search] Schema validation failed: ${errorDetail}`);
    } catch (validationErr) {
      logger.debug(`[research-knowledge-search] TypeBox validation error: ${validationErr}`);
    }
  }

  // Phase 4c: Agentic Repair — re-prompt the LLM with the schema embedded
  logger.warn('[research-knowledge-search] Background LLM response malformed, attempting agentic repair');

  const repaired = await repairJsonWithLlm<ResearchKnowledgeSynthesisResponse>(
    responseText,
    completeSimple,
    auth,
    {
      model,
      schema: ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
      context: 'Knowledge search extraction — synthesizing answer from reference documents',
      serviceName: 'ResearchKnowledgeSearch',
      signal,
    },
  );

  if (repaired) {
    // Agentic repair may return legacy format — coerce it
    const coerced = coerceResponse(repaired);
    if (coerced) return coerced;
    // If coercion fails but repair returned something, try it as-is
    if ('answer_status' in repaired) return repaired;
  }

  // Phase 4d: Safe fallback — treat as not found rather than crashing
  logger.error('[research-knowledge-search] Agentic repair failed, returning NOT_FOUND');
  return { answer_status: 'no', synthesis: '', citations: [] };
}

// ---------------------------------------------------------------------------
// Phase 5: Orchestration Steering
// ---------------------------------------------------------------------------

/**
 * Build the tool result based on the answer status.
 *
 * - "yes": Return the synthesis with citations. No live research needed.
 * - "maybe": Return the synthesis with citations, BUT append a message
 *   telling the host agent to also do live research to fill gaps.
 * - "no": Return the miss string, authorizing live research.
 */
function buildSteeringResult(
  result: ResearchKnowledgeSynthesisResponse,
  urls: string[],
): AgentToolResult<unknown> {
  const status = result.answer_status;

  // "no" — nothing found, pivot to live research
  if (status === 'no') {
    metrics.increment('research_knowledge_search_total', 1, { status: 'not_found' });
    return {
      content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
      details: { source: 'research_knowledge_search', found: false, answerStatus: 'no' },
    };
  }

  // "yes" or "maybe" — build the report
  const synthesis = result.synthesis || '';
  let report = synthesis;

  if (result.citations.length > 0) {
    report += '\n\n### Sources\n';
    for (let i = 0; i < result.citations.length; i++) {
      report += `${i + 1}. ${result.citations[i]}\n`;
    }
    report += '\n---';
  }

  if (status === 'maybe') {
    metrics.increment('research_knowledge_search_total', 1, { status: 'partial' });
    report += '\n\n' + RESEARCH_KNOWLEDGE_MAYBE_STRING;
    return {
      content: [{ type: 'text', text: report }],
      details: {
        source: 'research_knowledge_search',
        found: true,
        answerStatus: 'maybe',
        citations: result.citations,
        documentsSearched: urls.length,
      },
    };
  }

  // "yes" — complete answer
  metrics.increment('research_knowledge_search_total', 1, { status: 'found' });
  metrics.increment('research_knowledge_search_citations_total', result.citations.length);
  return {
    content: [{ type: 'text', text: report }],
    details: {
      source: 'research_knowledge_search',
      found: true,
      answerStatus: 'yes',
      citations: result.citations,
      documentsSearched: urls.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Error-path result builders
// ---------------------------------------------------------------------------

function missResult(reason: string): AgentToolResult<unknown> {
  metrics.increment('research_knowledge_search_total', 1, { status: reason });
  return {
    content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
    details: { source: 'research_knowledge_search', found: false, answerStatus: 'no', reason },
  };
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
      'If research_knowledge_search returns "no" (not found), proceed with the `research` tool for live web investigation.',
      'If research_knowledge_search returns "maybe" (partial), use the provided synthesis AND also do live research to fill gaps.',
      'If research_knowledge_search returns "yes" (found), you have a complete answer — no live research needed.',
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

      // Show the TUI widget immediately
      showKnowledgeSearchWidget(ctx);

      try {
        // ----------------------------------------------------------
        // Service resolution via central registry (not direct instantiation)
        // ----------------------------------------------------------
        let storeService: IKnowledgeStoreService;
        try {
          storeService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE);
        } catch {
          return missResult('store_unavailable');
        }

        if (!storeService.isReady()) {
          return missResult('store_not_ready');
        }

        const store = await storeService.getStore();

        const count = await store.count();
        if (count === 0) {
          return missResult('store_empty');
        }

        // ----------------------------------------------------------
        // Phase 2: Vector search → URL dedup → rebuildDocument
        // ----------------------------------------------------------
        const { text: referenceText, urls } = await assembleReferenceDocuments(p.queries, store);

        if (!referenceText || referenceText.length === 0) {
          return missResult('no_results');
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
          return missResult(modelError || 'no_model');
        }

        const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!authResult.ok) {
          logger.warn(`[research-knowledge-search] Model auth failed: ${authResult.error}`);
          return missResult('auth_failed');
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
        return buildSteeringResult(result, urls);
      } catch (error) {
        const durationMs = Date.now() - startTime;
        metrics.observe('research_knowledge_search_duration_ms', durationMs, { status: 'error' });
        metrics.increment('research_knowledge_search_total', 1, { status: 'error' });

        logger.error('[research-knowledge-search] Tool execution failed:', error);

        return {
          content: [{ type: 'text', text: RESEARCH_KNOWLEDGE_MISS_STRING }],
          details: { source: 'research_knowledge_search', found: false, answerStatus: 'no', error: String(error) },
        };
      } finally {
        // Always remove the TUI widget when done
        hideKnowledgeSearchWidget(ctx);
      }
    },
  };
}
