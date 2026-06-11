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

export type AnswerStatus = Static<typeof AnswerStatusEnum>;

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
 * Map legacy boolean to tri-state for backward compatibility during
 * Value.Convert coercion. If the LLM returns `answer_found: true/false`
 * (the old field), this converts it to the new `answer_status` enum.
 */
export function legacyBooleanToStatus(value: unknown): { answer_status: AnswerStatus } | null {
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    // If answer_status already present, no conversion needed
    if ('answer_status' in obj && typeof obj.answer_status === 'string') {
      return null;
    }
    // Convert legacy answer_found boolean
    if ('answer_found' in obj && typeof obj.answer_found === 'boolean') {
      return { answer_status: obj.answer_found ? 'yes' : 'no' };
    }
  }
  return null;
}
