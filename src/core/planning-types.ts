/**
 * Planning Types
 *
 * Type definitions for the planning service
 */

import type { Model } from '@mariozechner/pi-ai';

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
 * Researcher configuration
 */
export interface ResearcherConfig {
  id: string | number;
  name: string;
  goal: string;
  queries: string[];
  historicalLinks?: string[];
}

/**
 * Research plan
 */
export interface ResearchPlan {
  action?: 'synthesize' | 'delegate';
  researchers?: ResearcherConfig[];
  allQueries?: string[];
  content?: string;
}

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