/**
 * Service Interfaces for pi-research
 *
 * Central re-export barrel for all service interfaces.
 */

// Scheduler interfaces
export type { SearchResult, ScrapeResult, IScheduler, SchedulerMetadata, ISchedulerInstance, ISchedulerInternals, ISchedulerService } from './interfaces/scheduler-interfaces.ts';
export type { ISchedulerFactory } from './scheduler-factory.ts';

// Health check interfaces
export type { HealthCheckResult, HealthCheckCache, IHealthCheckService, IHealthRegistryService } from './interfaces/health-check-interfaces.ts';

// Knowledge store interfaces
export type { 
  IEmbedder, 
  IKnowledgeStore, 
  IKnowledgeStoreService, 
  IWriterQueue, 
  IMetricsSnapshot, 
  IMetricHistogram, 
  IngestionItem, 
  StoreUrlEntry, 
  StoreDocument,
  EmbedderOptions,
  EmbedderState,
  HFEnv,
  ONNXRuntimeEnv,
  DisposablePipeline
} from './interfaces/knowledge-interfaces.ts';

// State manager interfaces
export type { IStateManager } from './interfaces/state-manager-interfaces.ts';

// Process interfaces
export type { IProcessLifecycle, IGPUResourceService } from './interfaces/process-interfaces.ts';

// Observer interfaces
export type { ResearchObserver } from './interfaces/observer-interfaces.ts';

// Orchestration interfaces
export type { IResearchOrchestration, RunResearchersOptions, IResearchSynthesisService, ResearchOptions } from './interfaces/orchestration-interfaces.ts';

// Planning interfaces
export type { ResearchPlan, ResearcherConfig, SessionContext, GeneratePlanOptions, GenerateQueriesOptions, UpdatePlanOptions, IPlanningService } from './interfaces/planning-interfaces.ts';

// Service names
export { ServiceNames, type ServiceName } from './interfaces/service-names.ts';