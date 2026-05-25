/**
 * Orchestration Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Config } from '../../config.ts';
import type { ResearchPlan } from './planning-interfaces.ts';
import type { QueryResultWithError } from '../../web-research/types.ts';
import type { RunResearchersOptions } from '../../orchestration/orchestration-types.ts';

/**
 * Research Orchestration Service Interface
 */
export interface IResearchOrchestration extends IService {
  distributeSearchResults(plan: ResearchPlan, results: QueryResultWithError[]): Promise<Map<string, string[]>>;
  runResearchers(options: RunResearchersOptions, researcherLinks?: Map<string, string[]>): Promise<void>;
  runSearchBurst(queries: string[], config: Config, signal?: AbortSignal, onProgress?: (links: number) => void): Promise<QueryResultWithError[]>;
  storeLinkDescriptions(round: number, researchId: string, config: any): Promise<void>;
  checkHealth(round: number, researchId: string): Promise<boolean>;
}
