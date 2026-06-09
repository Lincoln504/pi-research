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
 * The internal schema the background LLM MUST output.
 *
 * - `answer_found`: Boolean indicating whether the reference documents
 *   contain a substantive answer to the user's question.
 * - `synthesis`: Optional synthesized answer with inline citation markers
 *   [1], [2], etc. Present when answer_found is true.
 * - `citations`: Array of source URLs used to construct the answer.
 */
export const ResearchKnowledgeSynthesisResponseSchema = Type.Object({
  answer_found: Type.Boolean({
    description: 'Whether the reference documents contain a substantive answer to the question.',
  }),
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