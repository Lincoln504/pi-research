/**
 * Planning Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Model } from '@mariozechner/pi-ai';

/**
 * Research plan structure returned by the coordinator/evaluator
 */
export interface ResearchPlan {
  action?: 'synthesize' | 'delegate' | 'wait';
  researchers?: ResearcherConfig[];
  allQueries?: string[];
  content?: string;
}

/**
 * Individual researcher configuration
 */
export interface ResearcherConfig {
  id: string | number;
  name: string;
  goal: string;
  queries: string[];
  historicalLinks?: string[];
}

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