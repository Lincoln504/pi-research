/**
 * Service Interfaces for pi-research
 *
 * This module re-exports all service interfaces for backward compatibility.
 * Individual interfaces are now in their own modules for better organization.
 */

// Scheduler interfaces
export type { SearchResult, IScheduler, SchedulerMetadata } from './interfaces/scheduler-interfaces.ts';

// Health check interfaces
export type { HealthCheckResult, HealthCheckCache, IHealthCheckService } from './interfaces/health-check-interfaces.ts';

// Knowledge store interfaces
export type { IEmbedder, IKnowledgeStore, IWriterQueue, IMetricsSnapshot, IMetricHistogram } from './interfaces/knowledge-interfaces.ts';

// State manager interfaces
export type { IStateManager } from './interfaces/state-manager-interfaces.ts';

// Planning interfaces
export type { ResearchPlan, ResearcherConfig, SessionContext, GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions, IPlanningService } from './interfaces/planning-interfaces.ts';

// Service names
export { ServiceNames, type ServiceName } from './interfaces/service-names.ts';