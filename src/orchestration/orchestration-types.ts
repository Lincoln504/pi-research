/**
 * Research Orchestration Types
 */

import type { ResearcherConfig } from '../core/service-interfaces.ts';
import type { StoreUrlEntry } from '../core/interfaces/knowledge-interfaces.ts';
export type { RunResearchersOptions } from '../core/interfaces/orchestration-interfaces.ts';

/**
 * Options for running a single researcher
 */
export interface RunResearcherOptions {
  config: ResearcherConfig;
  initialLinks: string[];
  historicalUrls: StoreUrlEntry[];
  sessionId: string;
  researchId: string;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  ctx: any;
  model: any;
  researchConfig: any;
  planningService: any;
  observer?: any;
  signal?: AbortSignal;
  sessionStart: number;
  excludeTools?: string[];
}