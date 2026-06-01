/**
 * Research Plan Types
 *
 * Core data types for research plans and researcher configuration.
 * Lives in a separate file so both planning-interfaces.ts and
 * observer-interfaces.ts can import without creating a circular dependency.
 */

import { Type } from 'typebox';

/**
 * Research plan structure returned by the coordinator/evaluator
 */
export interface ResearchPlan {
  action?: 'synthesize' | 'delegate' | 'wait';
  researchers: ResearcherConfig[];
  allQueries?: string[];
  content?: string;
  title?: string;
}

/**
 * Individual researcher configuration
 */
export interface ResearcherConfig {
  id: string | number;
  name: string;
  goal: string;
  queries: string[];
}

// ============================================================================
// TypeBox Schemas for Validation
// ============================================================================

export const ResearcherConfigSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  name: Type.String(),
  goal: Type.String(),
  queries: Type.Array(Type.String()),
});

export const ResearchPlanSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate'), Type.Literal('wait')])),
  researchers: Type.Array(ResearcherConfigSchema),
  allQueries: Type.Optional(Type.Array(Type.String())),
  content: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
});
