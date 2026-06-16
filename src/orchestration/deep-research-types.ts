/**
 * Deep Research Types
 *
 * Defines the schema for the monolithic ResearchState persisted in the session tree.
 */

import { Type, type Static } from 'typebox';

export const ResearchStatusSchema = Type.Union([
  Type.Literal('planning'),
  Type.Literal('researching'),
  Type.Literal('evaluating'),
  Type.Literal('synthesizing'),
  Type.Literal('completed'),
  Type.Literal('failed')
]);

export const SiblingStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed')
]);

/**
 * Individual research researcher (sibling) schema
 */
export const ResearchSiblingSchema = Type.Object({
  id: Type.String(), // e.g. "1.1", "2.1"
  query: Type.String(),
  status: SiblingStatusSchema,
  report: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  tokens: Type.Optional(Type.Number()),
  cost: Type.Optional(Type.Number()),
});

/**
 * Main deep research state schema
 */
export const SystemResearchStateSchema = Type.Object({
  version: Type.Number(),
  researchId: Type.String(), // Unique session ID
  rootQuery: Type.String(),
  complexity: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]), // 1: Normal, 2: Deep, 3: Ultra
  currentRound: Type.Number(),
  status: ResearchStatusSchema,
  lastUpdated: Type.Number(),
  
  // The full exhaustive list of aspects planned by the initial coordinator
  initialAgenda: Type.Array(Type.String()),
  
  // Global pool updated IMMEDIATELY by the scrape tool
  allScrapedLinks: Type.Array(Type.String()),
  
  // Sequence of research aspects actively being worked or completed
  aspects: Type.Record(Type.String(), ResearchSiblingSchema),
  
  // Track who was promoted to Lead Evaluator in this round to prevent race conditions
  promotedId: Type.Optional(Type.String()),

  // Final result if completed
  finalSynthesis: Type.Optional(Type.String()),
});

export type SystemResearchState = Static<typeof SystemResearchStateSchema>;
