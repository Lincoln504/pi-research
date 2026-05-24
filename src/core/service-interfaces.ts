/**
 * Service Interfaces for pi-research
 *
 * This module defines the TypeScript interfaces for all services
 * that will be managed by the ServiceRegistry.
 */

import type { IService } from './service-registry.ts';

// ============================================================================
// Scheduler Service Interface
// ============================================================================

/**
 * Scheduler search result
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  [key: string]: any;
}

/**
 * Base scheduler interface
 */
export interface IScheduler extends IService {
  /**
   * Run a search query
   */
  runSearch(query: string, config?: any): Promise<SearchResult[]>;

  /**
   * Scrape a URL
   */
  runScrape(url: string, config?: any): Promise<any>;

  /**
   * Run a health check
   */
  runHealthCheck(config?: any): Promise<{ success: boolean }>;

  /**
   * Shutdown the scheduler
   */
  shutdown(): Promise<void>;

  /**
   * Reset idle timer (for scheduler instances)
   */
  resetIdleTimerOnActivity?(): void;
}

/**
 * Scheduler service metadata
 */
export interface SchedulerMetadata {
  schedulerId: string;
  schedulerVersion: string;
  port?: number;
  pid: number;
  isLeader: boolean;
}

// ============================================================================
// Health Check Service Interface
// ============================================================================

/**
 * Health check result
 */
export interface HealthCheckResult {
  success: boolean;
  searchOk: boolean;
  scrapeOk: boolean;
  error?: string;
  timestamp: string;
}

/**
 * Health check cache state
 */
export interface HealthCheckCache {
  pending: Promise<HealthCheckResult> | null;
  failureCount: number;
  backoffUntil: number;
}

/**
 * Health check service interface
 */
export interface IHealthCheckService extends IService {
  /**
   * Get the cached pending health check promise
   */
  getPendingCheck(): Promise<HealthCheckResult> | null;

  /**
   * Set a pending health check promise
   */
  setPendingCheck(promise: Promise<HealthCheckResult> | null): void;

  /**
   * Get the failure count
   */
  getFailureCount(): number;

  /**
   * Increment the failure count
   */
  incrementFailureCount(): void;

  /**
   * Reset the failure count
   */
  resetFailureCount(): void;

  /**
   * Get the backoff timestamp
   */
  getBackoffUntil(): number;

  /**
   * Set the backoff timestamp
   */
  setBackoffUntil(timestamp: number): void;

  /**
   * Clear all cache state
   */
  clear(): void;

  /**
   * Check if a backoff is currently active
   */
  isBackoffActive(): boolean;

  /**
   * Get remaining backoff time in milliseconds
   */
  getBackoffRemainingMs(): number;
}

// ============================================================================
// Browser Manager Service Interface
// ============================================================================

/**
 * Browser manager service interface
 */
export interface IBrowserManagerService extends IService {
  /**
   * Get the current scheduler
   */
  getScheduler(config?: any): Promise<IScheduler>;

  /**
   * Get the current scheduler version
   */
  getSchedulerVersion(config?: any): string;

  /**
   * Force a scheduler restart
   */
  forceRestart(forceClearRemoteState?: boolean): Promise<void>;

  /**
   * Check if the browser is available
   */
  isBrowserAvailable(): boolean;

  /**
   * Run a browser task
   */
  runTask<T>(task: any, type: 'search' | 'scrape', config?: any, retries?: number): Promise<T>;

  /**
   * Run a health check
   */
  runHealthCheck(config?: any, retries?: number): Promise<{ success: boolean }>;

  /**
   * Stop the browser manager
   */
  stop(): Promise<void>;
}

// ============================================================================
// Knowledge Store Service Interfaces
// ============================================================================

/**
 * Embedder interface for text embedding operations
 */
export interface IEmbedder {
  /** Get the current device being used */
  getDevice(): string | null;
  /** Get the original device preference */
  getOriginalDevice(): string | null;
  /** Check if the embedder is initialized */
  isInitialized(): boolean;
  /** Embed a single text string */
  embed(text: string): Promise<Float32Array | number[]>;
  /** Embed multiple text strings */
  embedMany(texts: string[]): Promise<(Float32Array | number[])[]>;
  /** Dispose the embedder */
  dispose(): Promise<void>;
}

/**
 * Knowledge store interface for storage operations
 */
export interface IKnowledgeStore {
  /** Open the knowledge store */
  open(): Promise<void>;
  /** Close the knowledge store */
  close(): Promise<void>;
  /** Clear the knowledge store */
  clear(): Promise<void>;
  /** Rebuild full-text search index */
  rebuildFtsIndex(): Promise<void>;
}

/**
 * Writer queue interface for batching write operations
 */
export interface IWriterQueue {
  /** Drain the queue, processing all pending writes */
  drain(): Promise<void>;
}

/**
 * Metrics snapshot interface
 */
export interface IMetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, IMetricHistogram>;
}

/**
 * Metric histogram statistics interface
 */
export interface IMetricHistogram {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

// ============================================================================
// Service Names (Constants)
// ============================================================================

/**
 * Standard service names used throughout the application
 */
export const ServiceNames = {
  /**
   * Browser scheduler service
   */
  SCHEDULER: 'scheduler',

  /**
   * Health check cache service
   */
  HEALTH_CHECK_CACHE: 'health-check-cache',

  /**
   * Browser manager service
   */
  BROWSER_MANAGER: 'browser-manager',

  /**
   * State manager service
   */
  STATE_MANAGER: 'state-manager',

  /**
   * Knowledge store service
   */
  KNOWLEDGE_STORE: 'knowledge-store',

  /**
   * Metrics service
   */
  METRICS: 'metrics',

  /**
   * Planning service
   */
  PLANNING: 'planning',
} as const;

// ============================================================================
// Planning Service Interface
// ============================================================================

/**
 * Research plan structure returned by the coordinator/evaluator
 */
export interface ResearchPlan {
  action?: 'synthesize' | 'delegate';
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
  model: any;
  config: any;
  sessionContext: SessionContext;
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
  model: any;
  config: any;
  signal?: AbortSignal;
}

/**
 * Options for updating plan for next round
 */
export interface UpdatePlanOptions {
  currentPlan: ResearchPlan | null;
  reports: Map<string, string>;
  round: number;
  query: string;
  complexity: 1 | 2 | 3;
  model: any;
  config: any;
  signal?: AbortSignal;
  previousPlan: ResearchPlan | null;
  totalResearchersPlanned: number;
  mustSynthesize?: boolean;
  historicalLinksSection?: string;
}

/**
 * Planning service interface
 *
 * Responsible for generating research plans, coordinating researchers,
 * and managing query generation for multi-round research.
 */
export interface IPlanningService extends IService {
  /**
   * Generate a research plan
   *
   * @param options - Planning options including query, complexity, model, and config
   * @returns Promise resolving to a ResearchPlan
   */
  generatePlan(options: GeneratePlanOptions): Promise<ResearchPlan>;

  /**
   * Generate researcher configurations from a plan
   *
   * @param plan - The research plan
   * @param query - The root research query
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Array of researcher configurations
   */
  generateResearchers(
    plan: ResearchPlan,
    query: string,
    complexity: 1 | 2 | 3
  ): ResearcherConfig[];

  /**
   * Generate queries for a researcher
   *
   * @param options - Query generation options
   * @returns Promise resolving to an array of query strings
   */
  generateQueries(options: GenerateQueriesOptions): Promise<string[]>;

  /**
   * Update plan for next round (evaluator logic)
   *
   * @param options - Update plan options
   * @returns Promise resolving to the updated ResearchPlan
   */
  updatePlanForRound(options: UpdatePlanOptions): Promise<ResearchPlan>;

  /**
   * Get the query history
   *
   * @returns Array of all queries executed
   */
  getQueryHistory(): string[];

  /**
   * Add queries to history
   *
   * @param queries - Array of queries to add
   */
  addToQueryHistory(queries: string[]): void;

  /**
   * Get the current plan
   *
   * @returns Current plan or null if none exists
   */
  getCurrentPlan(): ResearchPlan | null;

  /**
   * Get the total number of researchers planned so far
   *
   * @returns Total researchers planned
   */
  getTotalResearchersPlanned(): number;

  /**
   * Get the max team size for a complexity level
   *
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Maximum team size
   */
  getTeamSize(complexity: 1 | 2 | 3): number;

  /**
   * Get the query budget per researcher for a complexity level
   *
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Maximum queries per researcher
   */
  getQueryBudget(complexity: 1 | 2 | 3): number;

  /**
   * Get complexity-specific guidance for the coordinator
   *
   * @param complexity - Complexity level (1, 2, or 3)
   * @param maxTeamSize - Maximum team size
   * @param queryBudget - Query budget per researcher
   * @returns Guidance string for the coordinator prompt
   */
  getComplexityGuidance(
    complexity: 1 | 2 | 3,
    maxTeamSize: number,
    queryBudget: number
  ): string;

  /**
   * Get complexity-specific guidance for the evaluator
   *
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Guidance string for the evaluator prompt
   */
  getEvaluatorComplexityGuidance(complexity: 1 | 2 | 3): string;

  /**
   * Get round phase guidance based on current round and max rounds
   *
   * @param currentRound - Current round number
   * @param maxRounds - Maximum rounds
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Guidance string based on round phase
   */
  getRoundPhaseGuidance(
    currentRound: number,
    maxRounds: number,
    complexity: 1 | 2 | 3
  ): string;

  /**
   * Cap researcher queries to stay within budget
   *
   * @param plan - The plan to cap
   * @param complexity - Complexity level (1, 2, or 3)
   * @returns Plan with capped queries
   */
  capResearcherQueries(plan: ResearchPlan, complexity: 1 | 2 | 3): ResearchPlan;

  /**
   * Parse JSON from LLM response into ResearchPlan
   *
   * @param text - Raw LLM response text
   * @returns Parsed ResearchPlan
   * @throws Error if parsing fails
   */
  parseJsonPlan(text: string): ResearchPlan;

  /**
   * Build a fallback coordinator plan when LLM fails
   *
   * @param rawText - The raw LLM response text
   * @param query - The root research query
   * @returns Fallback ResearchPlan
   */
  buildFallbackCoordinatorPlan(rawText: string, query: string): ResearchPlan;

  /**
   * Clear all planning state
   */
  clearPlanningState(): void;
}

// ============================================================================
// Service Names (Constants)
// ============================================================================

/**
 * Type of service names
 */
export type ServiceName = typeof ServiceNames[keyof typeof ServiceNames];