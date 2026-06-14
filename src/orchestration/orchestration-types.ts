/**
 * Research Orchestration Types
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import type { ResearcherConfig } from '../core/service-interfaces.ts';
import type { IPlanningService } from '../core/interfaces/planning-interfaces.ts';
import type { StoreUrlEntry } from '../core/interfaces/knowledge-interfaces.ts';
import type { Config } from '../config.ts';
import type { ResearchObserver } from '../core/interfaces/observer-interfaces.ts';
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
  ctx: ExtensionContext;
  model: Model<any>;
  researchConfig: Config;
  planningService: IPlanningService;
  observer?: ResearchObserver;
  signal?: AbortSignal;
  excludeTools?: string[];
}