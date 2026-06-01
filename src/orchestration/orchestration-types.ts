/**
 * Research Orchestration Types
 */

import type { ResearcherConfig } from '../core/service-interfaces.ts';
import type { StoreUrlEntry } from '../core/interfaces/knowledge-interfaces.ts';
import type { Config } from '../config.ts';
import type { ResearchObserver } from './research-observer.ts';
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
  researchConfig: Config;
  planningService: any;
  observer?: ResearchObserver;
  signal?: AbortSignal;
  excludeTools?: string[];
}