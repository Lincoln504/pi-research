/**
 * Service Names (Constants)
 */

/**
 * Standard service names used throughout the application
 */
export const ServiceNames = {
  SCHEDULER: 'scheduler',
  SCHEDULER_FACTORY: 'scheduler-factory',
  STATE_MANAGER: 'state-manager',
  KNOWLEDGE_STORE: 'knowledge-store',
  WRITER_QUEUE: 'writer-queue',
  METRICS: 'metrics',
  PLANNING: 'planning',
  PROCESS_LIFECYCLE: 'process-lifecycle',
  RESEARCH_ORCHESTRATION: 'research-orchestration',
  STATE_PATH_CONFIGURATION: 'state-path-configuration',
  // Helper services for state management
  FILE_LOCK_SERVICE: 'file-lock-service',
  GPU_RESOURCE_SERVICE: 'gpu-resource-service',
  STATE_SESSION_MANAGER: 'state-session-manager',
  STATE_BROWSER_MANAGER: 'state-browser-manager',
  STATE_BACKUP_MANAGER: 'state-backup-manager',
  STATE_METRICS_COLLECTOR: 'state-metrics-collector',
  STATE_VALIDATOR: 'state-validator',
  HEALTH_REGISTRY: 'health-registry',
  // Browser infrastructure services
  WORKER_POOL_MANAGER: 'worker-pool-manager',
  // Research session services
  RESEARCH_SESSION_SERVICE: 'research-session-service',
  RESEARCH_SYNTHESIS_SERVICE: 'research-synthesis-service',
  // Cross-process cap on concurrent research runs (Phase 1 run-cap)
  RESEARCH_RUN_SEMAPHORE: 'research-run-semaphore',
} as const;

/**
 * Type of service names
 */
export type ServiceName = typeof ServiceNames[keyof typeof ServiceNames];