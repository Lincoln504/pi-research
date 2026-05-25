/**
 * Planning Types
 *
 * Concrete type definitions and TypeBox schemas for the planning service.
 * Interfaces (ResearchPlan, ResearcherConfig, etc.) are the single source of
 * truth defined in planning-interfaces.ts and re-exported from here so that
 * all existing imports continue to work without change.
 */

import type { Model } from '@mariozechner/pi-ai';

// Single source of truth for ResearchPlan and ResearcherConfig is planning-interfaces.ts.
// Import here for use in option types below, and re-export for backward compatibility.
import type { ResearchPlan, ResearcherConfig } from './interfaces/planning-interfaces.ts';
export type { ResearchPlan, ResearcherConfig };

// TypeBox Schemas for Validation
import { Type } from 'typebox';

export const ResearcherConfigSchema = Type.Object({
    id: Type.Union([Type.String(), Type.Number()]),
    name: Type.String(),
    goal: Type.String(),
    queries: Type.Array(Type.String()),
    historicalLinks: Type.Optional(Type.Array(Type.String()))
});

export const ResearchPlanSchema = Type.Object({
    action: Type.Optional(Type.Union([Type.Literal('synthesize'), Type.Literal('delegate')])),
    researchers: Type.Optional(Type.Array(ResearcherConfigSchema)),
    allQueries: Type.Optional(Type.Array(Type.String())),
    content: Type.Optional(Type.String())
});

/**
 * Options for generating a plan
 */
export interface GeneratePlanOptions {
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  signal?: AbortSignal;
  historicalLinksSection?: string;
}

/**
 * Options for generating queries
 */
export interface GenerateQueriesOptions {
  researcher: ResearcherConfig;
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  signal?: AbortSignal;
}

/**
 * Options for updating a plan for the next round
 */
export interface UpdatePlanOptions {
  reports: Map<string, string>;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  signal?: AbortSignal;
  previousPlan: ResearchPlan | null;
  totalResearchersPlanned: number;
  mustSynthesize?: boolean;
  historicalLinksSection?: string;
}