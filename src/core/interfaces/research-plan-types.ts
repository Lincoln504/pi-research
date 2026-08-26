/**
 * Research Plan Types
 *
 * Core data types for research plans and researcher configuration.
 * Lives in a separate file so both planning-interfaces.ts and
 * observer-interfaces.ts can import without creating a circular dependency.
 */

import { Type, type Static } from 'typebox';

// ============================================================================
// TypeBox Schemas for Validation
// ============================================================================

/**
 * Individual researcher configuration schema
 */
export const ResearcherConfigSchema = Type.Object({
  id: Type.Union([Type.String(), Type.Number()]),
  name: Type.String(),
  goal: Type.String(),
  queries: Type.Array(Type.String()),
});

/**
 * Individual researcher configuration type
 */
export type ResearcherConfig = Static<typeof ResearcherConfigSchema>;

/**
 * Research plan structure schema
 */
export const ResearchPlanSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal('synthesize'),
    Type.Literal('delegate'),
    Type.Literal('wait')
  ])),
  // Optional at the schema level because a 'synthesize' response legitimately omits
  // researchers (its contract is { action, content }). The delegate-requires-researchers
  // invariant is enforced explicitly in parseJsonPlan() so that a valid synthesis is not
  // misrouted into the agentic-repair path. See research-plan-types history / planning-utils.
  researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
  allQueries: Type.Optional(Type.Array(Type.String())),
  content: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  // Set ONLY by buildFallbackCoordinatorPlan (never requested from the model): marks a
  // plan the engine synthesized after the model's planning output was unusable, so a
  // single-researcher fallback is distinguishable from a plan the model actually chose.
  // Without it a deep query silently degrades to one researcher with no user-visible
  // notice — the TUI/SDK see an ordinary plan (issue #9).
  fallback: Type.Optional(Type.Boolean()),
});

/**
 * Research plan structure type
 */
export type ResearchPlan = Static<typeof ResearchPlanSchema>;
