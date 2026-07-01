/**
 * Research Knowledge Search Types
 *
 * Strict contracts for the research_knowledge_search tool's internal data flow.
 * Phase 1 of the architecture: rigid schema definitions that the
 * background LLM MUST conform to, enforced via TypeBox validation
 * and agentic repair.
 */

import { Type, type Static, type TSchema } from 'typebox';

/**
 * Tri-state answer confidence.
 *
 * - `"yes"` — The documents contain a substantive, directly useful answer.
 * - `"maybe"` — The documents contain partial or tangential information
 *   that *might* be helpful but is NOT sufficient for a complete answer.
 *   The host agent should still consider live research to fill gaps.
 * - `"no"` — No relevant information found in the knowledge store.
 */
export const AnswerStatusEnum = Type.Union([
  Type.Literal('yes'),
  Type.Literal('maybe'),
  Type.Literal('no'),
]);

/**
 * The internal schema the background LLM MUST output.
 *
 * - `answer_status`: Tri-state enum indicating answer confidence.
 *   - `"yes"`: Documents contain a substantive answer.
 *   - `"maybe"`: Documents contain partial/tangential info — useful but
 *     insufficient. The synthesis (if present) summarizes what's available.
 *   - `"no"`: No relevant information found.
 * - `synthesis`: Optional synthesized answer with inline citation markers
 *   [1], [2], etc. Present when answer_status is "yes" or "maybe".
 * - `citations`: Array of source URLs used to construct the answer.
 */
export const ResearchKnowledgeSynthesisResponseSchema = Type.Object({
  answer_status: AnswerStatusEnum,
  synthesis: Type.Optional(Type.String({
    description: 'Synthesized answer with inline citation markers [1], [2], etc.',
  })),
  citations: Type.Array(Type.String(), {
    description: 'Source URLs used to construct the answer.',
  }),
});

export type ResearchKnowledgeSynthesisResponse = Static<typeof ResearchKnowledgeSynthesisResponseSchema>;

/**
 * The schema cast as TSchema for use with agentic-repair.
 */
export const ResearchKnowledgeSynthesisResponseSchemaAsTSchema =
  ResearchKnowledgeSynthesisResponseSchema as unknown as TSchema;

/**
 * Cheap relevance-triage response.
 *
 * The triage LLM reads only the SHORT per-candidate descriptions (a few hundred
 * chars each) — not the full rebuilt documents — and returns the 0-based indices
 * of the candidates that are genuinely relevant to the user's question. An empty
 * array means "nothing in the store is relevant" → the tool reports an instant
 * miss WITHOUT rebuilding documents or running the full synthesis LLM.
 *
 * This replaces the earlier idea of an embedding-similarity threshold, which was
 * shown to be neither model- nor store-size-robust (a large anisotropic vector
 * space gives every query a spuriously-close nearest neighbour). Letting the LLM
 * judge the descriptions is model-agnostic and adapts to any embedding model.
 */
export const KnowledgeRelevanceTriageSchema = Type.Object({
  relevant_indices: Type.Array(Type.Integer(), {
    description: '0-based indices of the candidate sources that are relevant to the question. Empty if none.',
  }),
});

export type KnowledgeRelevanceTriage = Static<typeof KnowledgeRelevanceTriageSchema>;
