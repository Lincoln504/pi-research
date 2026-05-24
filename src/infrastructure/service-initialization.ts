/**
 * Infrastructure Service Initialization Module
 *
 * This module registers all infrastructure-level services with the service registry.
 * Infrastructure services are registered by this module to avoid Core layer
 * depending on Infrastructure layer.
 */

import { registerService } from '../core/service-registry.ts';
import { ServiceNames } from '../core/service-interfaces.ts';
import { getSchedulerFactory } from './scheduler-factory-impl.ts';
import { StateManagerService } from './state-manager-service.ts';
import { KnowledgeStoreService } from './knowledge-store-service.ts';
import { MetricsService } from './metrics-service.ts';
import { logger } from '../logger.ts';

/**
 * Register all infrastructure services with the service registry
 */
export function registerInfrastructureServices(): void {
  logger.debug('[InfrastructureServiceInit] Registering infrastructure services...');

  // Register Scheduler Factory Service
  // This is the factory that creates scheduler instances
  registerService(
    ServiceNames.SCHEDULER_FACTORY,
    () => getSchedulerFactory(),
    {
      lazyInitialization: false, // Always available
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register State Manager Service
  registerService(
    ServiceNames.STATE_MANAGER,
    () => new StateManagerService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Knowledge Store Service
  registerService(
    ServiceNames.KNOWLEDGE_STORE,
    () => new KnowledgeStoreService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  // Register Metrics Service
  registerService(
    ServiceNames.METRICS,
    () => new MetricsService(),
    {
      lazyInitialization: true,
      allowOverwrite: false,
      enableLogging: true,
    }
  );

  logger.debug('[InfrastructureServiceInit] Infrastructure services registered');
}
