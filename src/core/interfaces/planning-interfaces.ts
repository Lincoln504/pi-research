/**
 * Planning Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ResearchObserver } from './observer-interfaces.ts';
import type { ResearchPlan, ResearcherConfig } from './research-plan-types.ts';
import type { Config } from '../../config.ts';

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
  sessionId: string;
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  cwd: string;
  signal?: AbortSignal;
  observer?: ResearchObserver;
  excludeTools?: string[];
  steeringMessages?: string[];
  /** Resolved config from the caller (SDK/orchestrator). Preferred over getConfig(cwd)
   *  so SDK code-config and ignoreGlobalConfig hermeticity reach the coordinator call. */
  config?: Config;
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
  sessionId: string;
  reports: Map<string, string>;
  /** Coverage digest per report id, for the ROUTING call — which reads these instead of
   *  the reports. Optional: when omitted, digests are derived from the report bodies so a
   *  caller that doesn't track them still routes on coverage rather than on nothing. */
  digests?: Map<string, string>;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  model: Model<any>;
  modelRegistry: ModelRegistry;
  cwd: string;
  signal?: AbortSignal;
  previousPlan: ResearchPlan | null;
  totalResearchersPlanned: number;
  mustSynthesize?: boolean;
  /** The caller's live round budget (base complexity max plus any steering-driven
   *  extension), e.g. from DeepResearchOrchestrator's extended `maxRounds`. When
   *  omitted, updatePlanForRound falls back to the base complexity-table value —
   *  which understates the budget once steering has extended it, skewing the
   *  round-phase-guidance ratio (and its EARLY/MIDDLE/LATE branch selection)
   *  toward LATE too early. Optional and additive: existing callers that don't
   *  pass it keep the prior behavior unchanged. */
  maxRounds?: number;
  observer?: ResearchObserver;
  excludeTools?: string[];
  steeringMessages?: string[];
  /** Resolved config from the caller (SDK/orchestrator). Preferred over getConfig(cwd)
   *  so SDK code-config and ignoreGlobalConfig hermeticity reach the evaluator/synthesis call. */
  config?: Config;
}

/**
 * Planning service interface
 */
export interface IPlanningService extends IService {
  generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan>;
  generateResearchers(plan: ResearchPlan, query: string, complexity: 1 | 2 | 3): ResearcherConfig[];
  generateQueries(options: GenerateQueriesOptions): Promise<string[]>;
  updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan>;
  getQueryHistory(sessionId: string): string[];
  addToQueryHistory(sessionId: string, queries: string[]): void;
  getCurrentPlan(sessionId: string): ResearchPlan | null;
  getTotalResearchersPlanned(sessionId: string): number;
  incrementTotalResearchersPlanned(sessionId: string, count: number): void;
  getTeamSize(complexity: 1 | 2 | 3): number;
  getQueryBudget(complexity: 1 | 2 | 3): number;
  getComplexityGuidance(complexity: 1 | 2 | 3, maxTeamSize: number, queryBudget: number): string;
  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string;
  getRoundPhaseGuidance(currentRound: number, maxRounds: number, complexity: 1 | 2 | 3, maxTeamSize: number): string;
  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3, serviceName: string, workerThreads?: number): ResearchPlan;
  parseJsonPlan(text: string): ResearchPlan;
  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan;
  clearPlanningState(sessionId?: string): void;
  isReady(): boolean;
}
