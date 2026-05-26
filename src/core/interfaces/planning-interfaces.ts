/**
 * Planning Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Model } from '@mariozechner/pi-ai';
import type { ResearchObserver } from './observer-interfaces.ts';
import type { ResearchPlan, ResearcherConfig } from './research-plan-types.ts';

export type { ResearchPlan, ResearcherConfig };
export { ResearcherConfigSchema, ResearchPlanSchema } from './research-plan-types.ts';

/**
 * Session context for planning operations
 */
export interface SessionContext {
  sessionId: string;
  researchId: string;
}

/**
 * Options for generating a research plan
 */
export interface GeneratePlanOptions {
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  signal?: AbortSignal;
  historicalLinksSection?: string;
  observer?: ResearchObserver;
}

/**
 * Options for generating queries for a researcher
 */
export interface GenerateQueriesOptions {
  researcher: ResearcherConfig;
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  signal?: AbortSignal;
}

/**
 * Options for updating plan for next round
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
  observer?: ResearchObserver;
}

/**
 * Planning service interface
 */
export interface IPlanningService extends IService {
  generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan>;
  generateResearchers(plan: ResearchPlan, query: string, complexity: 1 | 2 | 3): ResearcherConfig[];
  generateQueries(options: GenerateQueriesOptions): Promise<string[]>;
  updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan>;
  getQueryHistory(): string[];
  addToQueryHistory(queries: string[]): void;
  getCurrentPlan(): ResearchPlan | null;
  getTotalResearchersPlanned(): number;
  incrementTotalResearchersPlanned(count: number): void;
  getTeamSize(complexity: 1 | 2 | 3): number;
  getQueryBudget(complexity: 1 | 2 | 3): number;
  getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string;
  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string;
  getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3): string;
  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3): ResearchPlan;
  parseJsonPlan(text: string): ResearchPlan;
  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan;
  clearPlanningState(): void;
}
