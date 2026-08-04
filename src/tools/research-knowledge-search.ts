/**
 * Research Knowledge Search Tool
 *
 * A satellite tool for the main pi agent that searches the local vector
 * database for previously researched information. This is NOT a researcher
 * sub-agent tool — the research orchestration already injects historical
 * URLs into researcher prompts via the store_section mechanism.
 *
 * Architecture:
 *
 *   Phase 1: Strict Contracts — rigid JSON schema for background LLM output
 *   Phase 2: Candidate Retrieval — vector search → URL dedup → ranked candidates
 *            (descriptions only, no full-document rebuild yet)
 *   Phase 3: Conversational Continuity — pi SDK's buildSessionContext pipeline
 *   Phase 4.5: Relevance Triage — cheap, model-agnostic LLM judgement over the
 *            short descriptions; an empty result is an instant miss (no rebuild,
 *            no synthesis), and a triage fault fails open to all candidates
 *   Phase 5: Safe Data Rehydration — rebuildDocument for the relevant URLs, then
 *            stateless background synthesis (completeSimple + agentic repair)
 *   Phase 6: Orchestration Steering — tri-state result (yes/maybe/no)
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
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { completeSimple } from '../core/llm/pi-ai-completion.ts';
import type { Model } from '@earendil-works/pi-ai';
import { recordLlmUsage } from '../utils/llm-usage.ts';
import { buildSafeOptions, validateAndExtractText } from '../core/llm/llm-utils.ts';
import { getService, tryGetServiceContainerFromCtx } from '../core/service-registry.ts';
import { withTimeout } from '../core/llm/llm-timeout.ts';
import { abortableDelay } from '../web-research/retry-utils.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import type { IKnowledgeStoreService } from '../core/service-interfaces.ts';
import type { ResearchKnowledgeSynthesisResponse, KnowledgeRelevanceTriage } from './research-knowledge-types.ts';
import {
  ResearchKnowledgeSynthesisResponseSchema,
  ResearchKnowledgeSynthesisResponseSchemaAsTSchema,
  KnowledgeRelevanceTriageSchema,
} from './research-knowledge-types.ts';
import { logger } from '../logger.ts';
import { metrics } from '../utils/metrics.ts';
import { extractJson } from '../utils/json-utils.ts';
import { repairJsonWithLlm } from '../core/llm/agentic-repair.ts';
import { loadPrompt } from '../core/llm/prompts.ts';
import { formatParentContext } from '../orchestration/session-context.ts';
import { getConfig, type ConfigInterface, type Config } from '../config.ts';
import { createKnowledgeSearchPanel } from '../tui/knowledge-search-panel.ts';

// ---------------------------------------------------------------------------
// Phase 1: Tool Parameters
// ---------------------------------------------------------------------------

const ResearchKnowledgeSearchParams = Type.Object({
  queries: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 5,
    description:
      'Search queries for the knowledge store (1-5 queries).',
  }),
});

type ResearchKnowledgeSearchParams = Static<typeof ResearchKnowledgeSearchParams>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard limit on total reference text size (chars) to prevent token overflow.
 *  Exported for unit tests (bundle-neutral: internal symbol, tree-shaken). */
export const MAX_REFERENCE_CHARS = 120_000;

/** Maximum number of unique URLs to rebuild documents for.
 *  Exported for unit tests (bundle-neutral: internal symbol, tree-shaken). */
export const MAX_DOCUMENTS = 10;

/** Maximum number of candidate URLs (with descriptions) fed to the cheap relevance
 *  triage. Larger than MAX_DOCUMENTS because descriptions are tiny — the triage can
 *  survey a wider net before the full-document rebuild narrows to MAX_DOCUMENTS.
 *  Exported for unit tests. */
export const MAX_CANDIDATES = 24;

/** Per-candidate description length (chars) shown to the triage LLM. Descriptions
 *  are already short; this bounds a pathologically long one. Exported for tests. */
export const TRIAGE_DESCRIPTION_MAX_CHARS = 600;

/** Output-token budget for the triage call. Its output is just a small index array,
 *  so this is intentionally tiny (keeps a miss fast and cheap). */
const TRIAGE_MAX_TOKENS = 2048;

/**
 * Render the explicit search queries for the triage/synthesis prompts. The queries
 * are the PRIMARY relevance signal: retrieval is query-driven, but the relevance
 * triage and the synthesis LLM previously saw only the conversation history — which
 * is empty in the CLI / SDK / agent-skill paths (createMockContext has no session
 * branch), leaving them blind to the actual question and prone to non-deterministic
 * false "no results". Surfacing the queries makes the search reliable on every
 * surface, and robust for weaker models than the host's.
 */
export function formatQueriesBlock(queries: string[]): string {
  const cleaned = queries.map((q) => q.trim()).filter((q) => q.length > 0);
  if (cleaned.length === 0) return '(no explicit query provided)';
  return cleaned.map((q) => `- ${q}`).join('\n');
}

/** Widget ID for the knowledge search TUI panel */
const KNOWLEDGE_WIDGET_ID = 'pi-research-knowledge-search';

/**
 * System string returned when the answer is NOT found in the research
 * knowledge store. The exact phrasing is critical — the main pi agent
 * reads this as a signal to pivot to live web research.
 */
export const RESEARCH_KNOWLEDGE_MISS_STRING =
  'No results found. Live research can get the info.';

/**
 * System string appended when the knowledge store returned partial results.
 * The host agent gets a synthesis of what was found but is also told to
 * continue with live research for a more complete answer.
 */
export const RESEARCH_KNOWLEDGE_MAYBE_STRING =
  'Partial results found in knowledge store. Live research can fill gaps.';

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
// Phase 2: Candidate retrieval → cheap relevance triage → document rehydration
// ---------------------------------------------------------------------------

/** A single retrieved candidate: a URL plus its short synthesis-description.
 *  The description is what the cheap triage LLM reads (NOT the full document). */
export interface KnowledgeCandidate {
  url: string;
  description: string;
  provenance: string;
}

/**
 * Run the vector search for every query and deduplicate the resulting URLs into
 * a ranked candidate list, WITHOUT rebuilding any full documents. Each candidate
 * carries its short synthesis-description — enough for the cheap relevance triage
 * to judge, at a fraction of the token cost of the full rebuilt markdown.
 *
 * Deduplication uses a Map keyed on first-appearance order, so the earliest (most
 * relevant) query result for each URL — and its provenance/description — is kept.
 */
export async function collectCandidateUrls(
  queries: string[],
  store: import('../core/interfaces/knowledge-interfaces.ts').IKnowledgeStore,
): Promise<{ candidates: KnowledgeCandidate[]; provenanceByUrl: Map<string, string> }> {
  const order = new Map<string, number>();
  const provenanceByUrl = new Map<string, string>();
  const descriptionByUrl = new Map<string, string>();

  let failedQueries = 0;
  for (const query of queries) {
    try {
      const results = await store.findRelevantUrls(query, { limit: 20 });
      for (const entry of results) {
        if (!order.has(entry.url)) {
          order.set(entry.url, order.size);
          provenanceByUrl.set(entry.url, entry.provenance || 'unknown');
          descriptionByUrl.set(entry.url, entry.description || '');
        }
      }
    } catch (err) {
      failedQueries++;
      logger.debug(`[research-knowledge-search] Vector search failed for query "${query}": ${err}`);
    }
  }

  // Distinguish a backend outage from a genuine empty: if EVERY query threw (the store
  // reported content but the vector index/embedder is faulting), an empty candidate list
  // is a false miss. We still fail open (the caller reports a miss → host does live
  // research), but warn so the outage is not silent — the symmetric detection the
  // web-search path already has for "all queries failed".
  if (queries.length > 0 && failedQueries === queries.length) {
    logger.warn(
      `[research-knowledge-search] All ${queries.length} vector search(es) failed — ` +
      `treating as a miss, but this may be a knowledge-store outage rather than a genuine empty.`,
    );
  }

  // Sort by first-appearance order (lower = more relevant), cap the candidate pool.
  const candidates = [...order.keys()]
    .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity))
    .slice(0, MAX_CANDIDATES)
    .map((url) => ({
      url,
      description: descriptionByUrl.get(url) || '',
      provenance: provenanceByUrl.get(url) || 'unknown',
    }));

  return { candidates, provenanceByUrl };
}

/**
 * Rebuild pristine full documents for the given URLs via the store's native
 * rebuildDocument() (synthesis-description metadata blocks → unfragmented original
 * markdown, not stitched vector chunks), enforcing the total character budget.
 * `urls` is expected to already be ranked (most relevant first); it is capped at
 * MAX_DOCUMENTS. The returned `urls` is the capped input list (including any whose
 * rebuild yielded nothing) so callers can report how many documents were considered.
 */
export async function rebuildDocuments(
  urls: string[],
  provenanceByUrl: Map<string, string>,
  store: import('../core/interfaces/knowledge-interfaces.ts').IKnowledgeStore,
): Promise<{ text: string; urls: string[] }> {
  const sortedUrls = urls.slice(0, MAX_DOCUMENTS);
  const documentParts: string[] = [];
  let totalChars = 0;

  for (const url of sortedUrls) {
    try {
      const rebuilt = await store.rebuildDocument(url);
      if (!rebuilt) {
        logger.debug(`[research-knowledge-search] Could not rebuild document for ${url}`);
        continue;
      }

      const provenance = provenanceByUrl.get(url) || 'unknown';
      const ageLine = typeof rebuilt.ageDays === 'number' ? `#### Cache age: ~${rebuilt.ageDays} day(s) old\n` : '';
      const header = `\n---\n### Source: ${url}\n#### Provenance: ${provenance}\n${ageLine}`;
      const docText = rebuilt.text || '';
      const entry = header + docText;

      // Token budget enforcement: if this document would exceed the limit,
      // truncate it and stop adding any further (lower-ranked) documents.
      if (totalChars + entry.length > MAX_REFERENCE_CHARS) {
        const remaining = MAX_REFERENCE_CHARS - totalChars - header.length;
        if (remaining > 500) {
          documentParts.push(header + docText.slice(0, remaining) + '\n[TRUNCATED]');
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

/**
 * Convenience composition: collect candidates for the queries and rebuild ALL of
 * them (no triage). This is the permissive fall-back used when the relevance-triage
 * LLM is unavailable or fails — behaviourally identical to the pre-triage tool.
 */
export async function assembleReferenceDocuments(
  queries: string[],
  store: import('../core/interfaces/knowledge-interfaces.ts').IKnowledgeStore,
): Promise<{ text: string; urls: string[] }> {
  const { candidates, provenanceByUrl } = await collectCandidateUrls(queries, store);
  if (candidates.length === 0) {
    return { text: '', urls: [] };
  }
  return rebuildDocuments(candidates.map((c) => c.url), provenanceByUrl, store);
}

// ---------------------------------------------------------------------------
// Phase 3: Conversational Continuity
// ---------------------------------------------------------------------------

/**
 * Serialize the current conversation branch using pi SDK's native pipeline.
 * Produces a dense conversational transcript the background LLM can use
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

import { resolveResearchModel } from '../core/llm/research-model-resolver.ts';
import { safeGetApiKeyAndHeaders } from '../core/llm/model-registry-factory.ts';

// ---------------------------------------------------------------------------
// Phase 4: Stateless Background Execution + Agentic Repair
// ---------------------------------------------------------------------------

/**
 * Resolve the model to use for the background synthesis LLM.
 * Priority: RESEARCH_MODEL → ctx.model
 */
function resolveSynthesisModel(ctx: ExtensionContext, config: Config): { model?: Model<any>; error?: string } {
  try {
    const model = resolveResearchModel({
      modelRegistry: ctx.modelRegistry,
      hostModel: ctx.model as Model<any>,
      cwd: ctx.cwd,
      config,
    });
    return { model };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Validate a raw object against the response schema using TypeBox
 * coercion and checking.
 */
function validateResponse(raw: unknown): ResearchKnowledgeSynthesisResponse | null {
  if (!raw || typeof raw !== 'object') return null;

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
/**
 * Total attempts (1 initial + retries) for the background synthesis LLM call.
 * The synthesis call was previously single-shot: a transient provider failure (a 429
 * rate-limit, a timeout, a thinking-only/empty response, a 5xx) was caught by the tool's
 * outer handler and reported as a knowledge-store MISS, silently escalating the host agent
 * to a slow, costly live web run instead of serving the store. Matching the researcher
 * provider-retry default of 2 retries.
 */
const KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS = 3;
const KNOWLEDGE_SYNTHESIS_RETRY_BASE_MS = 1000;

/**
 * Whether an LLM-call failure is transient and worth retrying. Mirrors the rate-limit/timeout
 * signals surfaced by validateAndExtractText (llm-utils.ts) and the withTimeout wrapper.
 * Exported for unit testing.
 */
export function isTransientSynthesisError(message: string): boolean {
  const m = message.toLowerCase();
  // Numeric codes are matched on a word boundary so a token count embedded in a NON-transient
  // error (e.g. "maximum context length ... you requested 67500 tokens" → "500", or "13100
  // tokens" → "1310") does not trigger a pointless 3× retry before the call correctly fails.
  if (/\b(429|500|502|503|504|1310)\b/.test(m)) return true;
  return (
    m.includes('rate limit') ||
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('returned no text content') ||
    m.includes('overloaded') ||
    m.includes('econnreset') ||
    m.includes('fetch failed') ||
    // undici mid-stream aborts of the synthesis/triage streaming response: a dropped
    // connection surfaces as `TypeError: terminated` (cause "other side closed" / UND_ERR_SOCKET).
    m.includes('terminated') ||
    m.includes('other side closed') ||
    m.includes('socket hang up') ||
    m.includes('und_err')
  );
}

/** Exported for unit testing of the transient-retry loop. */
export async function runBackgroundExtraction(
  model: Model<any>,
  auth: { apiKey: string; headers?: Record<string, string> },
  conversationHistory: string,
  queries: string[],
  referenceDocuments: string,
  llmTimeout: number,
  maxTokens: number,
  thinkingLevel: Config['LLM_THINKING_LEVEL'],
  signal?: AbortSignal,
): Promise<ResearchKnowledgeSynthesisResponse> {
  const promptTemplate = loadPrompt('research-knowledge-search-extractor');
  if (!promptTemplate) {
    throw new Error('research-knowledge-search prompt template not found');
  }

  // Use FUNCTION replacers: referenceDocuments is rebuilt knowledge-store text (scraped web pages)
  // and conversationHistory/queries are arbitrary user text, all of which routinely contain `$`. A
  // plain string replacement interprets `$&`, `` $` ``, `$'`, `$$` as substitution patterns and
  // corrupts the extractor prompt (duplicating/eating template text) → wrong yes/maybe/no
  // classification. A function replacer inserts the value literally. (Same class as commit 78c16f98.)
  const systemPrompt = promptTemplate
    .replace('{{queries}}', () => formatQueriesBlock(queries))
    .replace('{{conversation_history}}', () => conversationHistory)
    .replace('{{reference_documents}}', () => referenceDocuments);

  const userMessage =
    'Analyze the reference documents above and extract the answer using the required JSON format.';

  // Phase 4a: Stateless LLM call — no AgentSession, no side-effects.
  // llmTimeout is resolved by the caller from the iface-aware Config so a
  // per-interface overlay (pi.env / cli.env) is honored here.
  // Bounded transient-retry: a 429/timeout/empty response on this single synthesis call must
  // not be swallowed into a knowledge-store MISS (which forces a needless live web run). A
  // genuine cancellation (signal) or a non-transient error (e.g. malformed-but-present text,
  // which flows on to the repair path) is NOT retried.
  let responseText: string;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const response = await withTimeout(
        completeSimple(model, {
          systemPrompt,
          messages: [
            { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
          ],
        }, buildSafeOptions(model, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal
        }, maxTokens, thinkingLevel)),
        llmTimeout,
        'knowledge-search-extraction',
      );

      // Track token and cost metrics for the background synthesis call
      recordLlmUsage(model, (response as any).usage, { component: 'knowledge_search' });

      responseText = validateAndExtractText(response, 'Knowledge Extraction');
      break;
    } catch (err) {
      // A real cancellation propagates immediately — no retry, no fallback.
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS || !isTransientSynthesisError(msg)) {
        throw err;
      }
      const delay = KNOWLEDGE_SYNTHESIS_RETRY_BASE_MS * attempt;
      metrics.increment('research_knowledge_search_synthesis_retries_total', 1);
      logger.warn(`[research-knowledge-search] Synthesis attempt ${attempt}/${KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS} failed transiently (${msg}); retrying in ${delay}ms`);
      // keepAlive=true: the retry is already committed and the next attempt must
      // run, so this sleep is foreground work. An unref'd timer here can be the
      // only pending handle and let the process exit mid-retry (see abortableDelay).
      await abortableDelay(delay, signal, true);
    }
  }

  // Phase 4b: Direct JSON extraction + TypeBox validation
  const extracted = extractJson<ResearchKnowledgeSynthesisResponse>(responseText, 'object');
  if (extracted.success && extracted.value) {
    const validated = validateResponse(extracted.value);
    if (validated) {
      return validated;
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
      // Match the budget of the call being repaired so a large synthesis is not re-truncated
      // at repairJsonWithLlm's smaller default (16384). Mirrors the planning-service repairs.
      maxTokens,
      thinkingLevel,
      onUsage: (rawUsage) => recordLlmUsage(model, rawUsage, { component: 'knowledge_search' }),
    },
  );

  if (repaired) {
    const validated = validateResponse(repaired);
    if (validated) return validated;
  }

  // Phase 4d: Safe fallback — treat as not found rather than crashing. This is a
  // fail-open (the host just falls back to live research), so warn — matching the
  // other fail-open paths in this file — rather than error.
  logger.warn('[research-knowledge-search] Agentic repair failed, returning NOT_FOUND');
  return { answer_status: 'no', synthesis: '', citations: [] };
}

// ---------------------------------------------------------------------------
// Phase 3.5: Cheap, model-agnostic relevance triage (descriptions only)
// ---------------------------------------------------------------------------

/**
 * Ask the LLM which candidates are actually relevant, reading ONLY their short
 * descriptions. This is the model-agnostic replacement for an embedding-similarity
 * gate: the vector index always returns SOME nearest neighbour, so we let the LLM —
 * which judged the original "Belize" miss correctly — decide relevance on cheap text
 * before paying to rebuild full documents and run the large synthesis call.
 *
 * Returns:
 *  - `string[]` (possibly empty) — triage ran: the relevant candidate URLs. An empty
 *    array authorises an instant miss with NO rebuild and NO synthesis LLM call.
 *  - `null` — triage could NOT run (no prompt, non-transient error, or malformed
 *    output). The caller then FAILS OPEN (uses all candidates), so a triage fault
 *    never wrongly hides real knowledge — worst case is the old, slower behaviour.
 *
 * A genuine cancellation (signal) propagates as a throw.
 * Exported for unit testing.
 */
export async function triageRelevantUrls(
  model: Model<any>,
  auth: { apiKey: string; headers?: Record<string, string> },
  conversationHistory: string,
  queries: string[],
  candidates: KnowledgeCandidate[],
  llmTimeout: number,
  thinkingLevel: Config['LLM_THINKING_LEVEL'],
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (candidates.length === 0) return [];

  const promptTemplate = loadPrompt('research-knowledge-relevance-triage');
  if (!promptTemplate) {
    logger.warn('[research-knowledge-search] Triage prompt missing; failing open to full synthesis');
    return null;
  }

  const candidateBlock = candidates
    .map((c, i) => {
      const desc = (c.description || '(no description available)').slice(0, TRIAGE_DESCRIPTION_MAX_CHARS);
      return `[${i}] ${c.url}\n${desc}`;
    })
    .join('\n\n');

  // FUNCTION replacers so literal `$`/`$&` in queries, descriptions or history are not
  // treated as regex substitution patterns (same class as the synthesis prompt).
  const systemPrompt = promptTemplate
    .replace('{{queries}}', () => formatQueriesBlock(queries))
    .replace('{{conversation_history}}', () => conversationHistory)
    .replace('{{candidates}}', () => candidateBlock);

  const userMessage = 'Return the JSON object listing the indices of the relevant candidates.';

  let responseText: string;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const response = await withTimeout(
        completeSimple(model, {
          systemPrompt,
          messages: [
            { role: 'user', content: [{ type: 'text', text: userMessage }], timestamp: Date.now() },
          ],
        }, buildSafeOptions(model, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal,
        }, TRIAGE_MAX_TOKENS, thinkingLevel)),
        llmTimeout,
        'knowledge-relevance-triage',
      );

      recordLlmUsage(model, (response as any).usage, { component: 'knowledge_triage' });

      responseText = validateAndExtractText(response, 'Knowledge Triage');
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS || !isTransientSynthesisError(msg)) {
        // Fail open: a triage fault must not hide real knowledge.
        logger.warn(`[research-knowledge-search] Triage failed (${msg}); failing open to full synthesis`);
        return null;
      }
      const delay = KNOWLEDGE_SYNTHESIS_RETRY_BASE_MS * attempt;
      metrics.increment('research_knowledge_search_triage_retries_total', 1);
      logger.warn(`[research-knowledge-search] Triage attempt ${attempt}/${KNOWLEDGE_SYNTHESIS_MAX_ATTEMPTS} failed transiently (${msg}); retrying in ${delay}ms`);
      // keepAlive=true: the retry is already committed and the next attempt must
      // run, so this sleep is foreground work. An unref'd timer here can be the
      // only pending handle and let the process exit mid-retry (see abortableDelay).
      await abortableDelay(delay, signal, true);
    }
  }

  // Coerce-then-validate exactly like validateResponse(): a single Value.Convert
  // wrapped in try/catch (Convert can throw on some malformed inputs), then check
  // the coerced value. A throw or a failed check falls through to the fail-open
  // path below — a triage fault must never hide real knowledge.
  const extracted = extractJson<KnowledgeRelevanceTriage>(responseText, 'object');
  let coerced: KnowledgeRelevanceTriage | null = null;
  if (extracted.success && extracted.value) {
    try {
      const converted = Value.Convert(KnowledgeRelevanceTriageSchema, extracted.value);
      if (Value.Check(KnowledgeRelevanceTriageSchema, converted)) {
        coerced = converted as KnowledgeRelevanceTriage;
      }
    } catch { /* fall through to malformed handling */ }
  }
  if (!coerced) {
    logger.warn('[research-knowledge-search] Triage output malformed; failing open to full synthesis');
    return null;
  }

  const seen = new Set<string>();
  const relevantUrls: string[] = [];
  for (const idx of coerced.relevant_indices) {
    const candidate = Number.isInteger(idx) && idx >= 0 && idx < candidates.length ? candidates[idx] : undefined;
    if (candidate && !seen.has(candidate.url)) {
      seen.add(candidate.url);
      relevantUrls.push(candidate.url);
    }
  }
  return relevantUrls;
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
export function buildSteeringResult(
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
// Error-path result builder
// ---------------------------------------------------------------------------

function missResult(reason: string): AgentToolResult<unknown> {
  metrics.increment('research_knowledge_search_total', 1, { status: reason });
  logger.info('[research-knowledge-search] Knowledge store miss:', reason);

  let text = RESEARCH_KNOWLEDGE_MISS_STRING;
  switch (reason) {
    case 'store_empty':
      text = 'No results found (knowledge store is empty). Live research can get the info.';
      break;
    case 'store_disabled':
      text = 'No results found (knowledge store is disabled in settings). Live research can get the info.';
      break;
    case 'store_not_ready':
      text = 'No results found (knowledge store is initializing). Live research can get the info.';
      break;
    case 'store_unavailable':
      text = 'No results found (knowledge store unavailable). Live research can get the info.';
      break;
    case 'no_results':
      text = 'No results found (no matching content). Live research can get the info.';
      break;
    case 'no_model':
      text = 'No results found (no model configured). Live research can get the info.';
      break;
    case 'auth_failed':
      text = 'No results found (authentication error). Live research can get the info.';
      break;
  }

  return {
    content: [{ type: 'text', text }],
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
export function createResearchKnowledgeSearchTool(iface?: ConfigInterface): ToolDefinition {
  return {
    name: 'research_knowledge_search',
    label: 'Research Knowledge Search',
    description:
      'Search the research knowledge store for previously investigated information. ' +
      'Check this first for a web-research question, before the live `research` tool — ' +
      'it is a local, instant lookup. Go to live research only if it returns a partial or no answer.',
    promptSnippet: 'Search research knowledge store',
    promptGuidelines: [
      'Check `research_knowledge_search` first for research tasks, before `research`.',
      'A bare "research X" request still starts here: check what is known, then go live only if needed.',
      'If status is "yes" (complete), answer from it; no live research needed.',
      'If status is "maybe" (partial), use the synthesis and call `research` to fill gaps.',
      'If status is "no" (empty), call `research` for live investigation.',
      'Do not call knowledge search and research for the same query in the same turn — wait for the result.',
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

      // Defensive validation (same pattern as the sibling search/scrape tools):
      // a string `queries` would otherwise iterate per-character downstream.
      if (!Value.Check(ResearchKnowledgeSearchParams, params)) {
        metrics.increment('research_knowledge_search_total', 1, { status: 'invalid_params' });
        return {
          content: [{ type: 'text', text: 'Invalid parameters for research_knowledge_search. Expected an array of 1-5 query strings.' }],
          details: { error: 'invalid_parameters' },
        };
      }

      const p = params as ResearchKnowledgeSearchParams;
      const container = tryGetServiceContainerFromCtx(ctx);
      // Prefer a config the caller already resolved and placed on the context
      // (the SDK/CLI seed ctx.config with their hermetic/overlay-resolved Config),
      // falling back to reading the per-interface overlay (pi.env / cli.env)
      // from disk. This keeps RESEARCH_MODEL + LLM_TIMEOUT_MS for synthesis
      // consistent with the run path and honors ignoreGlobalConfig.
      const config = (ctx as { config?: Config }).config ?? getConfig(ctx.cwd, iface);

      // Show the TUI widget immediately
      showKnowledgeSearchWidget(ctx);

      try {
        // Live-config gate: honor a mid-session Knowledge Mode switch to 'none'
        // immediately. An already-INITIALIZED store would otherwise keep serving
        // searches the user just disabled (the reverse direction, none→enabled,
        // revives via the getService call below).
        if (config.KNOWLEDGE_STORE_MODE === 'none') {
          return missResult('store_disabled');
        }

        // ----------------------------------------------------------
        // Service resolution via central registry
        // ----------------------------------------------------------
        let storeService: IKnowledgeStoreService;
        try {
          storeService = await getService<IKnowledgeStoreService>(ServiceNames.KNOWLEDGE_STORE, ctx, container);
        } catch {
          return missResult('store_unavailable');
        }

        // Do NOT short-circuit on isReady() here. Immediately after Knowledge Mode is enabled
        // via /research-config (no Pi restart), the store is still coming up — the getService
        // above triggers the revival, but the native embed stack + init lock take a few seconds,
        // during which isReady() is briefly false and would return a spurious "initializing"
        // miss (the user then thinks a restart is required). getStore() awaits initialization to
        // completion, so gate readiness on its result instead: it returns the store once up,
        // or null when the store is genuinely disabled/failed.
        const store = await storeService.getStore();
        if (!store) {
          // null = disabled (mode still 'none') or a genuine init failure — distinguish for the
          // user-facing message so a real failure doesn't read as "disabled in settings".
          const lifecycle = (storeService as any).lifecycle;
          return missResult(lifecycle === 'disabled' ? 'store_disabled' : 'store_not_ready');
        }

        const count = await store.count();
        if (count === 0) {
          return missResult('store_empty');
        }

        // ----------------------------------------------------------
        // Phase 2: Vector retrieval → ranked candidates (descriptions only, cheap)
        // ----------------------------------------------------------
        const { candidates, provenanceByUrl } = await collectCandidateUrls(p.queries, store);
        if (candidates.length === 0) {
          return missResult('no_results');
        }

        // ----------------------------------------------------------
        // Phase 3: Conversational continuity via pi SDK pipeline
        // ----------------------------------------------------------
        const conversationHistory = await serializeConversationHistory(ctx);

        // ----------------------------------------------------------
        // Phase 4: Model routing (needed for both triage and synthesis)
        // ----------------------------------------------------------
        const { model, error: modelError } = resolveSynthesisModel(ctx, config);
        if (modelError || !model) {
          // Use a FIXED metric reason: modelError is a raw error string (stack fragments /
          // model ids), and passing it as the { status } label would explode metric label
          // cardinality (one unbounded time-series per distinct error text). Log the detail.
          if (modelError) logger.warn(`[research-knowledge-search] Synthesis model resolution failed: ${modelError}`);
          return missResult('no_model');
        }

        const authResult = await safeGetApiKeyAndHeaders(ctx.modelRegistry, model);
        if (!authResult.ok) {
          logger.warn(`[research-knowledge-search] Model auth failed: ${authResult.error}`);
          return missResult('auth_failed');
        }
        const auth = { apiKey: authResult.apiKey || '', headers: authResult.headers };

        // ----------------------------------------------------------
        // Phase 4.5: Cheap relevance triage over descriptions. This is the
        // model-agnostic replacement for an embedding-similarity gate: the vector
        // index always returns *some* nearest neighbour, so we let the LLM judge the
        // short descriptions before paying to rebuild full documents + synthesize.
        // ----------------------------------------------------------
        const triaged = await triageRelevantUrls(
          model, auth, conversationHistory, p.queries, candidates,
          config.LLM_TIMEOUT_MS, config.LLM_THINKING_LEVEL, signal,
        );
        // null = triage unavailable/failed → fail open to all candidates (never hide
        // real knowledge). A non-null result is authoritative, including an empty one.
        const chosenUrls = triaged === null ? candidates.map((c) => c.url) : triaged;
        logger.debug(
          `[research-knowledge-search] Triage: ${candidates.length} candidates → ` +
          `${triaged === null ? 'FAIL-OPEN (all)' : `${chosenUrls.length} relevant`}`,
        );
        if (chosenUrls.length === 0) {
          // Triage judged nothing relevant → instant miss, NO document rebuild and NO
          // synthesis call. This is the fast path that fixes the slow-empty behaviour.
          const durationMs = Date.now() - startTime;
          metrics.observe('research_knowledge_search_duration_ms', durationMs, { status: 'triaged_out' });
          return missResult('no_results');
        }

        // ----------------------------------------------------------
        // Phase 5: Rebuild ONLY the relevant documents → full synthesis
        // ----------------------------------------------------------
        const { text: referenceText, urls } = await rebuildDocuments(chosenUrls, provenanceByUrl, store);
        if (!referenceText || referenceText.length === 0) {
          return missResult('no_results');
        }

        const result = await runBackgroundExtraction(
          model,
          auth,
          conversationHistory,
          p.queries,
          referenceText,
          config.LLM_TIMEOUT_MS,
          // Synthesis budget, not planning: this call distills up to ~30k tokens of
          // reference documents into an answer, so the smaller PLANNING_MAX_TOKENS
          // ceiling truncated the output. SYNTHESIS_MAX_TOKENS is the right bound.
          config.SYNTHESIS_MAX_TOKENS,
          config.LLM_THINKING_LEVEL,
          signal,
        );

        const durationMs = Date.now() - startTime;
        metrics.observe('research_knowledge_search_duration_ms', durationMs);

        // ----------------------------------------------------------
        // Phase 6: Orchestration Steering
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
