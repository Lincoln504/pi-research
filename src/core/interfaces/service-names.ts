/**
 * Service Names (Constants)
 */

/**
 * Standard service names used throughout the application
 */
export const ServiceNames = {
  SCHEDULER: 'scheduler',
  SCHEDULER_FACTORY: 'scheduler-factory',
  HEALTH_CHECK_CACHE: 'health-check-cache',
  STATE_MANAGER: 'state-manager',
  KNOWLEDGE_STORE: 'knowledge-store',
  WRITER_QUEUE: 'writer-queue',
  METRICS: 'metrics',
  PLANNING: 'planning',
} as const;

/**
 * Type of service names
 */
export type ServiceName = typeof ServiceNames[keyof typeof ServiceNames];