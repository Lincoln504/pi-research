/**
 * Orchestration Service Interfaces
 */

import type { IService } from '../service-registry.ts';
import type { Config } from '../../config.ts';
import type { ResearchPlan, ResearcherConfig } from './planning-interfaces.ts';
import type { QueryResultWithError } from '../../web-research/types.ts';
import type { StoreUrlEntry } from './knowledge-interfaces.ts';

import type { Model } from '@earendil-works/pi-ai';
import type { ExtensionContext, AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { ResearchObserver } from './observer-interfaces.ts';

/**
 * Options for running a research task
 */
export interface ResearchOptions {
  ctx: ExtensionContext;
  query: string;
  depth?: 0 | 1 | 2 | 3;
  complexity?: 1 | 2 | 3;
  model?: Model<any>;
  observer?: ResearchObserver;
  onUpdate?: (update: AgentToolResult<any>) => void;
  sessionId: string;
  researchId: string;
  config?: Config;
  excludeTools?: string[];
  signal?: AbortSignal;
}

/**
 * Options for running researchers in parallel
 */
export interface RunResearchersOptions {
  plan: { researchers?: ResearcherConfig[] };
  options: {
    sessionId: string;
    researchId: string;
    query: string;
    complexity: 1 | 2 | 3;
    excludeTools?: string[];
    ctx: ExtensionContext;
    model: Model<any>;
    config?: Config;
    observer?: ResearchObserver;
  };
  currentRound: number;
  signal?: AbortSignal;
}

/**
 * Research Synthesis Service Interface
 */
export interface IResearchSynthesisService extends IService {
  storeReport(researchId: string, researcherId: string, report: string): void;
  getAllReports(researchId: string): Map<string, string>;
  getReport(researchId: string, id: string): string | undefined;
  getReportsForRound(researchId: string, round: number): Map<string, string>;
  getReportCount(researchId: string): number;
  hasReports(researchId: string): boolean;
  clearReports(researchId?: string): void;
  buildFallbackSynthesis(researchId: string, currentRound?: number): string;
  ensureCitedLinks(researchId: string, result: string): string;
  appendSteeringGuidance(result: string, steeringMessages: any[]): string;
}

/**
 * Research Orchestration Service Interface
 */
export interface IResearchOrchestration extends IService {
  runResearch(options: ResearchOptions, signal?: AbortSignal): Promise<string>;
  cleanupResearchServices(sessionId?: string, researchId?: string): Promise<void>;
  distributeSearchResults(plan: ResearchPlan, results: QueryResultWithError[]): Promise<Map<string, string[]>>;
  runResearchers(options: RunResearchersOptions, researcherLinks?: Map<string, string[]>, storeLinks?: Map<string, StoreUrlEntry[]>): Promise<void>;
  runSearchBurst(queries: string[], config: Config, signal?: AbortSignal, onProgress?: (links: number) => void): Promise<QueryResultWithError[]>;
  storeLinkDescriptions(sessionId: string, round: number, researchId: string, config: Config): Promise<void>;
  checkHealth(round: number, researchId: string): Promise<boolean>;
}
