/**
 * Orchestration Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Config } from '../../config.ts';
import type { ResearchPlan, ResearcherConfig } from './planning-interfaces.ts';
import type { QueryResultWithError } from '../../web-research/types.ts';

/**
 * Options for running researchers in parallel
 */
export interface RunResearchersOptions {
  plan: { researchers?: ResearcherConfig[] };
  options: { sessionId: string; researchId: string } & any;
  currentRound: number;
  signal?: AbortSignal;
}

/**
 * Research Orchestration Service Interface
 */
export interface IResearchOrchestration extends IService {
  distributeSearchResults(plan: ResearchPlan, results: QueryResultWithError[]): Promise<Map<string, string[]>>;
  runResearchers(options: RunResearchersOptions, researcherLinks?: Map<string, string[]>): Promise<void>;
  runSearchBurst(queries: string[], config: Config, signal?: AbortSignal, onProgress?: (links: number) => void): Promise<QueryResultWithError[]>;
  storeLinkDescriptions(sessionId: string, round: number, researchId: string, config: any): Promise<void>;
  checkHealth(round: number, researchId: string): Promise<boolean>;
}
