/**
 * Research Orchestration Types
 */

import type { ResearcherConfig } from '../core/service-interfaces.ts';

/**
 * Options for running researchers in parallel
 */
export interface RunResearchersOptions {
  plan: { researchers?: ResearcherConfig[] };
  options: {
    sessionId: string;
    researchId: string;
  } & any;
  currentRound: number;
  signal?: AbortSignal;
}

/**
 * Options for running a single researcher
 */
export interface RunResearcherOptions {
  config: ResearcherConfig;
  initialLinks: string[];
  historicalUrls: string[];
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
}